/**
 * @fileoverview Tool: imf_query_dataset — query a dataflow by dimension key over a time range.
 * Key codes are trimmed and resolved against the DSD codelists before the fetch,
 * so a misspelled or misplaced code fails with nearby codes instead of reading
 * as missing coverage. Periods are compared as the date spans they name, so a bound coarser than the
 * observation frequency covers every sub-period inside it. A key resolving to
 * several series carries each one's own unit/scale/decimals, inline and on the
 * canvas. Large result sets spill to DataCanvas for SQL analysis; without a
 * canvas they are cut to the same response budget as a time-ascending prefix.
 * @module mcp-server/tools/definitions/imf-query-dataset.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { CanvasIdSchema, type ColumnSchema } from '@cyanheads/mcp-ts-core/canvas';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { idGenerator } from '@cyanheads/mcp-ts-core/utils';
import { getCanvas } from '@/services/canvas/canvas-accessor.js';
import { getImfSdmxService } from '@/services/imf-sdmx/imf-sdmx-service.js';
import type {
  AvailabilityResult,
  CodelistEntry,
  Observation,
  SeriesAttributes,
} from '@/services/imf-sdmx/types.js';

/** Maximum serialized size of a staged tool result, across both MCP result channels. */
const RESPONSE_BUDGET_CHARS = 100_000;

/** Framework-style random suffix for explicitly registered IMF canvas tables. */
const TABLE_NAME_CHARS = '0123456789abcdef';

/** IMF SDMX 3.0 data portal base URL — used to construct per-dataflow attribution links. */
const IMF_DATA_PORTAL = 'https://data.imf.org/';

/**
 * How a scale of `"0"` reads in formatted text. Scale is the power of ten the
 * IMF publishes a series in, and values already arrive in base units, so `"0"`
 * says only that the series is published in units. A bare `0` beside a value
 * reads as a quantity — as an observation of zero — so it is named instead,
 * and the formatted channel still says what the structured one does.
 */
const PUBLISHED_IN_UNITS = 'published in units';

/**
 * Most per-series rows the formatted channel renders. A `*` key resolves to
 * hundreds of series (WEO's `*.NGDPD+NGDP_RPCH.A` is 420), and a table that long
 * costs more than the observations it annotates. `structuredContent` keeps every
 * entry, and each canvas row carries its own unit/scale/decimals, so the cap
 * bounds the rendering rather than the data — it is disclosed, never silent.
 */
const SERIES_METADATA_PREVIEW_ROWS = 20;

/**
 * Render a scale attribute for a reader as the publication magnitude it names:
 * null stays absent, `"0"` is units, and any other code N is units of 10^N.
 * The code is a power of ten already applied to the value, never a factor
 * still to apply, and the value column header says base units beside it.
 */
function scaleLabel(scale: string | null): string | null {
  if (scale == null) return null;
  return scale === '0' ? PUBLISHED_IN_UNITS : `${PUBLISHED_IN_UNITS} of 10^${scale}`;
}

/**
 * One GFM table cell holding text the tool did not author, or `—` when the
 * upstream left it null. A `|` would end the cell and a backtick can open a code
 * span across the rest of the row, so both are backslash-escaped, after the
 * backslash itself so an escape in the text cannot swallow the one added here.
 * A line break would end the row, so it becomes a space.
 */
function tableCell(text: string | null): string {
  if (text == null) return '—';
  return text.replace(/[\\|`]/g, '\\$&').replace(/\r\n|\r|\n/g, ' ');
}

/** The Period line's value: a range for both bounds, and a lone bound named as the one it is. */
function periodLabel(start: string | undefined, end: string | undefined): string | undefined {
  if (start && end) return `${start} – ${end}`;
  if (start) return `from ${start}`;
  if (end) return `through ${end}`;
  return undefined;
}

/** One `DIM: codes` clause per dimension, stating how many of how many when the listing is capped. */
function describeCoverage(availableCodes: AvailabilityResult['available_codes']): string {
  return Object.entries(availableCodes)
    .map(([dim, { codes, count }]) =>
      count > codes.length
        ? `${dim}: ${codes.length} of ${count} codes with data shown (${codes.join(', ')})`
        : `${dim}: ${codes.join(', ')}`,
    )
    .join('; ');
}

/**
 * Statuses that say only that a value is not available, compared lowercased.
 * The catalog spells the marker `NA` (`GFS_SOEF`, `FAS`), `n.a.` (`CPI`) and
 * `na` (`FSIBSIS`); a null value already says as much.
 */
const NOT_AVAILABLE_STATUSES = new Set(['na', 'n.a.']);

/**
 * A null value carrying no status, or only a not-available marker, is padding:
 * calendar-padded series carry these for periods before data starts. Any other
 * status on a null value (`C`, `T`, `/temporarily removed …`) says something the
 * null does not, so that row is kept.
 */
function isNullPadding(obs: Observation): boolean {
  return (
    obs.value === null &&
    (obs.status === null || NOT_AVAILABLE_STATUSES.has(obs.status.toLowerCase()))
  );
}

/** Largest `last_n_observations`, above the longest series the portal publishes (an IRFCL daily series spans 9,437 days). */
const MAX_LAST_N_OBSERVATIONS = 10_000;

/** A blank from a form client is "unset", never a value to validate. */
const blankAsUnset = <T extends z.ZodType>(schema: T) =>
  z.preprocess((value) => (value === '' ? undefined : value), schema);

/**
 * Each series' last `n` observations, in their original order. Rows arrive
 * time-sorted by label, and one series' labels share a format, so a series'
 * last rows here are its latest periods.
 */
function lastNPerSeries(observations: Observation[], n: number): Observation[] {
  const taken = new Map<string, number>();
  const selected = observations.toReversed().filter((obs) => {
    const count = taken.get(obs.series_key) ?? 0;
    taken.set(obs.series_key, count + 1);
    return count < n;
  });
  return selected.reverse();
}

/** Most nearby codes an `invalid_key_code` failure names per rejected code. */
const MAX_CODE_SUGGESTIONS = 5;

/** A key code missing from its position's codelist, as `invalid_key_code` reports it. */
interface InvalidKeyCode {
  /** Another dimension whose codelist holds the code, when one does. */
  belongsTo?: string;
  code: string;
  dimension: string;
  /** One-based key position. */
  position: number;
  suggestions: string[];
}

/** The codelist spelling of `code`: an exact match first, then a case-insensitive one. */
function resolveCode(code: string, codelist: readonly CodelistEntry[]): string | undefined {
  const lower = code.toLowerCase();
  return (
    codelist.find((entry) => entry.id === code) ??
    codelist.find((entry) => entry.id.toLowerCase() === lower)
  )?.id;
}

/** True when `a` and `b` differ by at most one insertion, deletion, or substitution. */
function withinOneEdit(a: string, b: string): boolean {
  if (Math.abs(a.length - b.length) > 1) return false;
  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
  let i = 0;
  while (i < shorter.length && shorter[i] === longer[i]) i++;
  return shorter.length === longer.length
    ? shorter.slice(i + 1) === longer.slice(i + 1)
    : shorter.slice(i) === longer.slice(i + 1);
}

/**
 * Up to {@link MAX_CODE_SUGGESTIONS} codes nearest `code`, compared
 * case-insensitively in codelist order: the codes it is a prefix of (US → USA),
 * or failing those, the codes one edit away (USB → USA).
 */
function nearestCodes(code: string, codelist: readonly CodelistEntry[]): string[] {
  const lower = code.toLowerCase();
  const ids = codelist.map((entry) => entry.id);
  const prefixed = ids.filter((id) => id.toLowerCase().startsWith(lower));
  const near =
    prefixed.length > 0 ? prefixed : ids.filter((id) => withinOneEdit(lower, id.toLowerCase()));
  return near.slice(0, MAX_CODE_SUGGESTIONS);
}

/** One rejected code as the error message names it, with its correction when there is one. */
function describeInvalidCode({
  belongsTo,
  code,
  dimension,
  position,
  suggestions,
}: InvalidKeyCode): string {
  const notes = [
    ...(belongsTo ? [`belongs to ${belongsTo}, not ${dimension}`] : []),
    ...(suggestions.length > 0 ? [`nearest ${dimension} codes: ${suggestions.join(', ')}`] : []),
  ];
  const detail =
    notes.length > 0
      ? notes.join(' — ')
      : `no close match; page the ${dimension} codes with imf_get_database (dimension_id=${dimension}, codelist_filter)`;
  return `position ${position} (${dimension}) '${code}' — ${detail}`;
}

/** The inclusive span of dates a period label names. */
interface PeriodSpan {
  /** Last date of the span, as a date key. */
  hi: number;
  /** First date of the span, as a date key. */
  lo: number;
}

/**
 * A calendar date as the comparable integer `YYYYMMDD`. Ordering is the only
 * operation period comparison needs, so the closing edge of a month, quarter,
 * half-year, or year can be day 31 without consulting the calendar: no real
 * date within that month sorts above it, and none in the next month sorts below.
 */
function dateKey(year: number, month: number, day: number): number {
  return year * 10_000 + month * 100 + day;
}

/** Day number closing any month-or-coarser span, and the largest a date may name. */
const LAST_DAY = 31;

/**
 * Resolve a period label to the span of dates it names.
 *
 * A period is an interval, not a point: `2023` names January–December 2023 and
 * `2023-Q1` names January–March. Comparing labels as strings instead conflates
 * the two ends of that interval, which is what made `end_period: "2023"` reject
 * `2023-M01` while `start_period: "2023"` admitted it.
 *
 * Recognized labels — every shape api.imf.org emits, since a label the parser
 * does not know is a label the range filter cannot apply:
 *   Annual:       `YYYY`         → January–December of that year
 *   Semi-annual:  `YYYY-SN`      → the half-year's six months (PIP)
 *   Quarterly:    `YYYY-QN`      → the quarter's three months
 *   Monthly:      `YYYY-MM`      → that month (input format)
 *   Monthly:      `YYYY-MNN`     → that month (upstream format, e.g. `1956-M01`)
 *   Daily:        `YYYY-MM-DD`   → that day (IRFCL, CCI)
 *
 * Returns null for anything else; callers decide whether null is fatal (input
 * validation) or a pass-through (per-observation filtering).
 */
function periodSpan(period: string): PeriodSpan | null {
  const annual = /^(\d{4})$/.exec(period);
  if (annual) {
    const year = Number(annual[1]);
    return { lo: dateKey(year, 1, 1), hi: dateKey(year, 12, LAST_DAY) };
  }

  const semiAnnual = /^(\d{4})-S([12])$/.exec(period);
  if (semiAnnual) {
    const year = Number(semiAnnual[1]);
    const half = Number(semiAnnual[2]);
    return { lo: dateKey(year, half * 6 - 5, 1), hi: dateKey(year, half * 6, LAST_DAY) };
  }

  const quarterly = /^(\d{4})-Q([1-4])$/.exec(period);
  if (quarterly) {
    const year = Number(quarterly[1]);
    const quarter = Number(quarterly[2]);
    return { lo: dateKey(year, quarter * 3 - 2, 1), hi: dateKey(year, quarter * 3, LAST_DAY) };
  }

  const daily = /^(\d{4})-(\d{2})-(\d{2})$/.exec(period);
  if (daily) {
    const year = Number(daily[1]);
    const month = Number(daily[2]);
    const day = Number(daily[3]);
    const calendarDate = new Date(Date.UTC(year, month - 1, day));
    if (
      calendarDate.getUTCFullYear() !== year ||
      calendarDate.getUTCMonth() !== month - 1 ||
      calendarDate.getUTCDate() !== day
    ) {
      return null;
    }
    const key = dateKey(year, month, day);
    return { lo: key, hi: key };
  }

  // Monthly, in the input format (YYYY-MM) or the upstream one (YYYY-MNN).
  const monthly = /^(\d{4})-(\d{2})$/.exec(period) ?? /^(\d{4})-M(\d{1,2})$/.exec(period);
  if (monthly) {
    const month = Number(monthly[2]);
    if (month < 1 || month > 12) return null;
    const year = Number(monthly[1]);
    return { lo: dateKey(year, month, 1), hi: dateKey(year, month, LAST_DAY) };
  }

  return null;
}

/**
 * Return true if an observation's own period overlaps the requested window.
 *
 * Overlap rather than containment: each bound expands to its inclusive edge
 * (start to its first date, end to its last), and an observation is kept when
 * any part of the period it names falls inside. That is what makes a bound
 * coarser than the data inclusive — `end_period: "2023"` keeps `2023-M12` and
 * `2023-Q4` — and it treats a bound finer than the data the same way instead of
 * silently dropping the observation that straddles it.
 */
function periodInRange(
  timePeriod: string,
  start: PeriodSpan | null | undefined,
  end: PeriodSpan | null | undefined,
): boolean {
  if (!start && !end) return true;
  const span = periodSpan(timePeriod);
  if (!span) return true; // unrecognized format — don't filter
  if (start && span.hi < start.lo) return false;
  if (end && span.lo > end.hi) return false;
  return true;
}

/**
 * Earliest and latest period labels present in an observation set, ordered by
 * the dates they name rather than by string. Reported when a period filter
 * empties an otherwise non-empty response, so the caller can see the window the
 * data actually occupies.
 */
function observedRange(observations: Observation[]): { first: string; last: string } {
  let first: string | undefined;
  let last: string | undefined;
  let earliest = Number.POSITIVE_INFINITY;
  let latest = Number.NEGATIVE_INFINITY;

  for (const obs of observations) {
    const span = periodSpan(obs.time_period);
    if (!span) continue;
    if (span.lo < earliest) {
      earliest = span.lo;
      first = obs.time_period;
    }
    if (span.hi > latest) {
      latest = span.hi;
      last = obs.time_period;
    }
  }

  // No label parsed — fall back to the service's time-ascending ordering.
  return {
    first: first ?? observations[0]?.time_period ?? '',
    last: last ?? observations[observations.length - 1]?.time_period ?? '',
  };
}

interface SeriesMetadata {
  decimals: number | null;
  scale: string | null;
  series_key: string;
  unit: string | null;
}

/** Domain result fields consumed by the formatter and response-budget measurement. */
interface QueryDatasetResult {
  canvas_id?: string;
  dataflow_id: string;
  end_period?: string;
  key: string;
  last_n_observations?: number;
  observation_count: number;
  observations: Observation[];
  retrieval_guidance?: string;
  series_attributes: SeriesAttributes;
  series_metadata?: SeriesMetadata[];
  source: string;
  staged: boolean;
  start_period?: string;
  table_name?: string;
  truncated: boolean;
}

/** Render the domain result identically for normal delivery and budget measurement. */
function formatQueryDataset(result: QueryDatasetResult) {
  const lines: string[] = [];
  lines.push(`## IMF Data: ${result.dataflow_id} — \`${result.key}\``);

  const period = periodLabel(result.start_period, result.end_period);
  if (period) lines.push(`**Period:** ${period}`);
  if (result.last_n_observations !== undefined) {
    lines.push(`**Last observations:** ${result.last_n_observations} per series`);
  }

  const { unit, scale, decimals } = result.series_attributes;
  const primaryMeta = [unit, scaleLabel(scale), decimals != null ? `${decimals} decimals` : null]
    .filter(Boolean)
    .join(' | ');

  if (result.series_metadata) {
    const shown = result.series_metadata.slice(0, SERIES_METADATA_PREVIEW_ROWS);
    const heading =
      shown.length < result.series_metadata.length
        ? `\n**Series attributes** — ${shown.length} of ${result.series_metadata.length} series shown; every entry remains in structuredContent${result.staged ? ', and every canvas row carries its own unit, scale, and decimals' : ''}\n`
        : '\n**Series attributes** — one row per series\n';
    lines.push(heading);
    lines.push('| Series Key | Unit | Scale | Decimals |');
    lines.push('|:-----------|:-----|:------|---------:|');
    for (const series of shown) {
      lines.push(
        `| ${tableCell(series.series_key)} | ${tableCell(series.unit)} | ${tableCell(scaleLabel(series.scale))} | ${series.decimals ?? '—'} |`,
      );
    }
    if (primaryMeta) {
      lines.push(
        `\n\`series_attributes\` describes the first row (${result.series_metadata[0]?.series_key ?? ''}): ${primaryMeta}\n`,
      );
    }
  } else if (primaryMeta) {
    lines.push(`**Series:** ${primaryMeta}`);
  }

  lines.push(
    `**Observations:** ${result.observation_count} | **Staged:** ${result.staged} | **Truncated:** ${result.truncated}`,
  );

  if (result.staged) {
    lines.push(
      `\n> Full dataset staged on canvas${result.truncated ? '; inline observations are a preview' : '; every observation also fits inline'}.` +
        `\n> **Canvas ID:** \`${result.canvas_id}\`` +
        `\n> **Table:** \`${result.table_name}\``,
    );
  }

  if (result.observations.length > 0) {
    lines.push('\n| Series Key | Time Period | Value (base units) | Status |');
    lines.push('|:-----------|:------------|-------------------:|:-------|');
    for (const obs of result.observations) {
      const val = obs.value != null ? obs.value.toString() : '—';
      lines.push(
        `| ${tableCell(obs.series_key)} | ${tableCell(obs.time_period)} | ${val} | ${tableCell(obs.status)} |`,
      );
    }
  }

  lines.push(`\n_${result.source}_`);
  if (result.retrieval_guidance) lines.push(`\n> ${result.retrieval_guidance}`);

  return [{ type: 'text' as const, text: lines.join('\n') }];
}

/**
 * Measure the exact success envelope mcp-ts-core emits: validated
 * domain output in structuredContent, formatter blocks in content[], and the
 * optional notice enrichment as both a merged field and a trailer block.
 * A contract boundary test locks this to runToolContract's production shape.
 */
function serializedResultChars(result: QueryDatasetResult, notice?: string): number {
  const content = formatQueryDataset(result);
  return JSON.stringify({
    structuredContent: { ...result, ...(notice ? { notice } : {}) },
    content: notice ? [...content, { type: 'text' as const, text: `\n\n> ${notice}` }] : content,
  }).length;
}

/**
 * The result carrying the longest observation prefix whose whole envelope fits
 * the response budget — or, when not even the empty prefix fits, the size of
 * that fixed part. Observations arrive time-sorted, so a prefix is the earliest
 * periods across every series. `build(count)` assembles the result carrying the
 * first `count` observations.
 */
function fitToBudget(
  build: (count: number) => QueryDatasetResult,
  total: number,
  notice: string | undefined,
): { result: QueryDatasetResult } | { fixedChars: number } {
  const fixedChars = serializedResultChars(build(0), notice);
  if (fixedChars > RESPONSE_BUDGET_CHARS) return { fixedChars };
  let lo = 0;
  let hi = total;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (serializedResultChars(build(mid), notice) <= RESPONSE_BUDGET_CHARS) lo = mid;
    else hi = mid - 1;
  }
  return { result: build(lo) };
}

/**
 * Guidance for a result cut to the budget without DataCanvas: where the prefix
 * ends and each way to reach the rest. It names no dataframe tool, since none is
 * registered without a canvas.
 */
function inlineTruncationGuidance(shown: Observation[], total: number): string {
  const last = shown.at(-1)?.time_period;
  const extent = last
    ? `observations holds the first ${shown.length} of ${total} in time order, through time_period ${last}`
    : `observations is empty: not even the first of ${total} fits the response budget`;
  const resume = last
    ? `set start_period to ${last} to continue from that period (it is returned again in full), `
    : '';
  return (
    `${extent}. DataCanvas is not enabled, so the rest was not staged. To reach it, narrow the key to fewer series, ` +
    `${resume}bound the window with start_period/end_period, use last_n_observations for each series' latest values, ` +
    'or run the server with CANVAS_PROVIDER_TYPE=duckdb to stage the full result.'
  );
}

export const imfQueryDataset = tool('imf_query_dataset', {
  description:
    'Query an IMF SDMX dataflow by dimension key over a time range. ' +
    'Returns observations with time_period, value, and status, plus the unit, scale, and ' +
    'decimals of each series — a key resolving to several series carries one entry per series ' +
    'in series_metadata, since unit and scale differ between them. ' +
    'Requires imf_get_database first to obtain the correct key_format and valid dimension codes. ' +
    'Country codes are ISO 3-letter (USA, GBR, DEU — not US, GB, DE). ' +
    'Key format: dot-separated codes in DSD keyPosition order (e.g. USA.NGDP_RPCH.A for WEO). ' +
    'Every position must carry a code: use + to combine codes (e.g. USA+GBR.NGDP_RPCH.A) ' +
    'and * to match every code at a position (e.g. *.NGDP_RPCH.A for all countries); * stands alone and cannot join a + list. ' +
    "Codes are matched case-insensitively and checked against each dimension's codelist before the query — " +
    'an unknown code is rejected with the nearest valid codes. ' +
    'Codelists from imf_get_database enumerate the code universe, not actual coverage — ' +
    'valid codes can still return no_data if the combination has no series. ' +
    'start_period and end_period must be valid period strings (YYYY, YYYY-SN, YYYY-QN, ' +
    'YYYY-MM, or a calendar-valid YYYY-MM-DD) with start_period no later than end_period; malformed or ' +
    'reversed ranges are rejected. ' +
    'A bound covers the whole period it names, so end_period 2023 includes 2023-M12 and 2023-Q4. ' +
    "last_n_observations keeps each series' last N observations — 1 is each series' latest value, " +
    'the cheap way to ask many countries for their latest figure. ' +
    'Values are in base units everywhere, staged canvas rows included: scale is the power of ten the IMF ' +
    'publishes a series in (value / 10^scale is the published figure), never a factor still to apply. ' +
    'A response is held to 100,000 serialized characters. With DataCanvas enabled (CANVAS_PROVIDER_TYPE=duckdb), ' +
    'a larger result (multi-country, long time range) spills to it: call imf_dataframe_describe first to inspect ' +
    'staged tables and columns, then imf_dataframe_query for SQL analysis. Without DataCanvas, a larger result ' +
    'returns its earliest observations with truncated=true, and retrieval_guidance names the last period returned ' +
    'and how to narrow the query.',
  annotations: {
    readOnlyHint: true,
    idempotentHint: true,
    openWorldHint: true,
  },
  input: z.object({
    dataflow_id: z
      .string()
      .describe(
        'Dataflow identifier from imf_list_databases, e.g. WEO, BOP, CPI. ' +
          'Matched case-insensitively; the response echoes the catalog spelling.',
      ),
    agency_id: z
      .string()
      .optional()
      .describe(
        'Agency ID, e.g. IMF.RES or IMF.STA. Auto-detected from dataflow list when omitted.',
      ),
    version: z
      .string()
      .optional()
      .describe('Dataflow version. Auto-detected from dataflow list when omitted.'),
    key: z
      .string()
      .describe(
        'Dot-separated dimension codes in DSD keyPosition order. ' +
          'Call imf_get_database to get key_format and valid codes first. ' +
          'Use + to combine codes at one position (e.g. USA+GBR.NGDP_RPCH.A). ' +
          'Use * to match every code at a position — *.NGDP_RPCH.A returns the ' +
          'indicator for all countries, and CAN.*.A every indicator for Canada. ' +
          'Every position needs a code or a *; an empty segment (USA..A) is rejected. ' +
          'A * stands alone at its position — combined with other codes (USA+*) it is rejected. ' +
          'Codes are trimmed and matched case-insensitively (usa resolves to USA), and the response echoes the canonical key. ' +
          "A code missing from its dimension's codelist is rejected before the query, naming the nearest valid codes. " +
          'Country codes are ISO 3-letter: USA not US, GBR not GB, DEU not DE.',
      ),
    start_period: z
      .string()
      .optional()
      .describe(
        'Start of time range (inclusive). Accepts any of YYYY (annual), ' +
          'YYYY-SN (semi-annual, e.g. 2023-S1), YYYY-QN (quarterly, e.g. 2023-Q1), ' +
          'YYYY-MM (monthly), or a calendar-valid YYYY-MM-DD (daily), whatever the ' +
          "dataflow's frequency. The bound covers the whole period it names, so " +
          'start_period 2023 admits 2023-M01 and 2023-Q1. ' +
          'Observations before this period are excluded from the result.',
      ),
    end_period: z
      .string()
      .optional()
      .describe(
        'End of time range (inclusive). Same formats as start_period, and must not ' +
          'be earlier than it. The bound covers the whole period it names, so ' +
          'end_period 2023 admits 2023-M12 and 2023-Q4. ' +
          'Observations after this period are excluded from the result.',
      ),
    last_n_observations: blankAsUnset(
      z.number().int().min(1).max(MAX_LAST_N_OBSERVATIONS).optional(),
    ).describe(
      "Keep only each series' last N observations, an integer from 1 to 10,000; 1 returns each series' latest value. " +
        'Latest is per series: series end at different periods, and a WEO series ends in its projection years (e.g. 2031), ' +
        'so set end_period to stop at a past year. With start_period or end_period, the last N inside that range. ' +
        'A series with fewer than N observations is returned whole. Omit to return every observation.',
    ),
    canvas_id: CanvasIdSchema.optional().describe(
      'Existing canvas ID to accumulate results into across multiple queries. ' +
        'This selects the destination only; it does not force staging. Use output_mode="canvas" to stage an under-budget result.',
    ),
    output_mode: z
      .enum(['auto', 'canvas'])
      .default('auto')
      .describe(
        'Result placement. auto returns an under-budget result inline and spills only when needed. ' +
          'canvas explicitly stages the full result, using canvas_id when supplied or allocating a fresh canvas.',
      ),
  }),
  output: z.object({
    dataflow_id: z
      .string()
      .describe('Dataflow identifier that was queried, in its catalog spelling, e.g. WEO.'),
    key: z
      .string()
      .describe(
        'Dimension key used in the query, trimmed and with each code in its codelist spelling, e.g. USA.NGDP_RPCH.A.',
      ),
    start_period: z
      .string()
      .optional()
      .describe('Earliest period covered; absent when the full available range was used.'),
    end_period: z
      .string()
      .optional()
      .describe('Latest period covered; absent when the full available range was used.'),
    last_n_observations: z
      .number()
      .optional()
      .describe(
        "The last_n_observations input, echoed when set: observations holds each series' last N in the range. Absent when every observation was returned.",
      ),
    observations: z
      .array(
        z
          .object({
            series_key: z
              .string()
              .describe(
                'Dot-separated dimension codes identifying this series, e.g. USA.NGDP_RPCH.A. ' +
                  'Matches the single-country equivalent of the query key — useful when a query covers multiple countries.',
              ),
            time_period: z
              .string()
              .describe(
                'Time label as emitted by the upstream API. Annual: YYYY (e.g. 2023). ' +
                  'Semi-annual: YYYY-SN (e.g. 2023-S1). Quarterly: YYYY-QN (e.g. 2023-Q1). ' +
                  'Monthly: YYYY-MNN (e.g. 2023-M01, not YYYY-MM). Daily: YYYY-MM-DD (e.g. 2023-01-05). ' +
                  'Every one of these is also accepted as a start_period/end_period bound, ' +
                  'so a label from this field can be passed straight back in.',
              ),
            value: z
              .number()
              .nullable()
              .describe(
                'Observation value in base units, e.g. 29298025000000 for US GDP of $29.3 trillion; null when missing. ' +
                  "The series' scale is already reflected in it: never apply scale to this value.",
              ),
            status: z
              .string()
              .nullable()
              .describe(
                'Observation status flag exactly as the dataflow publishes it, e.g. T, B, C, or NA; ' +
                  'null when the observation carries none. The flags are not a shared vocabulary across dataflows. ' +
                  'A null value whose only status is the not-available marker NA or n.a. (any letter case) is omitted as padding; ' +
                  'a null value with any other status is returned.',
              ),
          })
          .describe('A single time-series observation.'),
      )
      .describe(
        'Inline observations, oldest period first. When truncated=true this is the budget-limited time-ascending prefix of the result; observation_count remains the full count.',
      ),
    series_attributes: z
      .object({
        unit: z
          .string()
          .nullable()
          .describe(
            'Unit of measure as the upstream code, e.g. PT (percent), USD, XDC (domestic currency), NUM (count). ' +
              'Null when the response carries no unit for the series — many dataflows publish none.',
          ),
        scale: z
          .string()
          .nullable()
          .describe(
            'Power of ten the IMF publishes this series in, as the upstream code: "9" is billions, "6" millions, "0" units. ' +
              'Observation values are already in base units, so the published figure is value / 10^scale.',
          ),
        decimals: z.number().nullable().describe('Number of decimal places shown.'),
      })
      .describe(
        'Attributes of the first series in the result — the same series as series_metadata[0]. ' +
          'A key with + or * resolves to several series whose scale and unit differ, and this ' +
          'field describes only the first of them: read series_metadata for the rest, and never ' +
          'apply these values to another series_key.',
      ),
    series_metadata: z
      .array(
        z
          .object({
            series_key: z
              .string()
              .describe('Series these attributes belong to, matching observations[].series_key.'),
            unit: z
              .string()
              .nullable()
              .describe(
                'Unit of measure for this series as the upstream code, e.g. PT (percent), USD, ' +
                  'XDC (domestic currency). Null when the response carries none for it.',
              ),
            scale: z
              .string()
              .nullable()
              .describe(
                'Power of ten the IMF publishes this series in, as the upstream code: "9" is billions, "0" units. ' +
                  "This series' observation values are already in base units.",
              ),
            decimals: z
              .number()
              .nullable()
              .describe('Number of decimal places shown for this series.'),
          })
          .describe('Unit, scale, and decimals for one series in the result.'),
      )
      .optional()
      .describe(
        'Per-series attributes, one entry per distinct series_key in the result. Present only ' +
          'when the query resolved to more than one series; a single-series query carries its ' +
          'values in series_attributes instead. Unit and scale differ across series in one query — ' +
          'WEO NGDPD is USD published in billions (scale 9) while NGDP_RPCH is PT at scale 0 — so interpret each series ' +
          'against its own entry.',
      ),
    observation_count: z
      .number()
      .describe('Total observations in the result, after any last_n_observations selection.'),
    staged: z
      .boolean()
      .describe(
        'True when the complete observation set is stored on DataCanvas. canvas_id and table_name are present whenever true.',
      ),
    truncated: z
      .boolean()
      .describe(
        'True only when observations is an incomplete preview of observation_count. A result can be staged=true and truncated=false when every observation also fits inline, ' +
          'and staged=false and truncated=true when DataCanvas is not enabled and the full result exceeds the response budget.',
      ),
    canvas_id: z
      .string()
      .optional()
      .describe(
        'DataCanvas session ID — present when staged=true. Pass first to imf_dataframe_describe, then to imf_dataframe_query.',
      ),
    table_name: z
      .string()
      .optional()
      .describe(
        'DuckDB table name on the canvas — present when staged=true; reference in SQL via FROM <table_name>.',
      ),
    retrieval_guidance: z
      .string()
      .optional()
      .describe(
        'Present on every staged result, where it names the imf_dataframe_describe-before-imf_dataframe_query retrieval workflow, ' +
          'and on a result truncated without DataCanvas, where it names the last time_period returned and how to narrow the query for the rest.',
      ),
    source: z
      .string()
      .describe(
        'Attribution string required by IMF data terms: "Source: International Monetary Fund, <dataflow name>, <link>".',
      ),
  }),

  errors: [
    {
      reason: 'dataflow_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'dataflow_id does not match any known dataflow on api.imf.org',
      severity: 'warning',
      recovery: 'Call imf_list_databases to browse available dataflow IDs.',
    },
    {
      reason: 'no_data',
      code: JsonRpcErrorCode.NotFound,
      when: 'Key is structurally valid but the dataflow holds no series for this code combination, or the dataflow publishes no series at all',
      /**
       * A coverage miss is this tool's ordinary negative answer, not an
       * incident — the response carries availability the caller acts on. Logging
       * it at `error` beside upstream faults is what makes the error stream
       * unreadable at the level alerting works on.
       */
      severity: 'notice',
      recovery:
        'Read the availability context in the error. An empty dataflow means no key will return data — call imf_list_databases and pick another dataflow. Otherwise, series_count 0 means the code itself has no coverage and dataflow_availability names codes that do, while series_count above 0 means the combination is wrong and available_codes names the codes that have data, stating how many of a dimension it shows when the list is capped.',
    },
    {
      reason: 'no_data_in_range',
      code: JsonRpcErrorCode.NotFound,
      when: 'The key returned observations but start_period/end_period excluded every one of them',
      severity: 'notice',
      recovery:
        'The key is valid — widen start_period/end_period to overlap the period range reported in the error, or omit both to get the full series.',
    },
    {
      reason: 'key_dimension_mismatch',
      code: JsonRpcErrorCode.ValidationError,
      when: "Number of dot-separated segments in key does not match the dataflow's DSD dimension count",
      severity: 'warning',
      recovery:
        'Call imf_get_database to get the correct key_format for this dataflow, then reconstruct the key.',
    },
    {
      reason: 'empty_key_segment',
      code: JsonRpcErrorCode.ValidationError,
      when: 'A dot-separated position in key is empty or blank, which matches no series upstream',
      severity: 'warning',
      recovery:
        'Put * at that position to match every code there, or a code from imf_get_database to pin it.',
    },
    {
      reason: 'wildcard_in_code_list',
      code: JsonRpcErrorCode.ValidationError,
      when: 'A key position combines * with other codes in a + list, where the portal ignores the * and returns only the listed codes',
      severity: 'warning',
      recovery:
        'Use * alone at that position to match every code there, or list the wanted codes joined with +.',
    },
    {
      reason: 'invalid_key_code',
      code: JsonRpcErrorCode.ValidationError,
      when: "A key code is not in its dimension's codelist, checked before any data request",
      severity: 'warning',
      recovery:
        "Replace each named code with one from its dimension's codelist — a suggested code, or one found with imf_get_database using dimension_id and codelist_filter.",
    },
    {
      reason: 'invalid_period_format',
      code: JsonRpcErrorCode.ValidationError,
      when: 'start_period or end_period is not one of the recognized period formats',
      severity: 'warning',
      recovery:
        'Use YYYY (annual), YYYY-SN (semi-annual), YYYY-QN (quarterly, e.g. 2023-Q1), YYYY-MM (monthly), or a calendar-valid YYYY-MM-DD (daily).',
    },
    {
      reason: 'invalid_period_range',
      code: JsonRpcErrorCode.ValidationError,
      when: 'start_period is later than end_period',
      severity: 'warning',
      recovery: 'Provide start_period less than or equal to end_period (chronological order).',
    },
    {
      reason: 'structure_unavailable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'The dataflow structure (DSD) cannot be fetched after the dataflow catalog resolved successfully',
      recovery: 'Retry the structure lookup after a short wait.',
    },
    {
      reason: 'canvas_unavailable',
      code: JsonRpcErrorCode.ConfigurationError,
      when: 'output_mode="canvas" was requested but DataCanvas is disabled',
      recovery:
        'Enable DataCanvas with CANVAS_PROVIDER_TYPE=duckdb, or omit output_mode/use output_mode="auto" for an inline result.',
    },
    {
      reason: 'response_too_large',
      code: JsonRpcErrorCode.SerializationError,
      when: 'The fixed part of the result — full series_metadata, plus the retrieval handle when staging — exceeds the response budget before any observation can be included',
      severity: 'warning',
      recovery:
        'Narrow the dimension key to fewer series so the full series_metadata fits in one response.',
    },
    {
      reason: 'dataflow_list_unavailable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'The dataflow catalog that dataflow_id is resolved against could not be fetched — fires before the DSD and data lookups are attempted',
      retryable: true,
      // Raised inside ImfSdmxService.fetchDataflows() and re-thrown untouched.
      thrownBy: 'service',
      recovery:
        'Retry in a few moments; the IMF SDMX 3.0 portal is intermittently unavailable and the catalog is cached for an hour once it succeeds.',
    },
  ],

  enrichment: {
    notice: z
      .string()
      .optional()
      .describe(
        'Populated when a period bound was set but some observations carry a time_period label the range filter does not recognize. Composes with staged retrieval_guidance when both apply.',
      ),
  },

  async handler(input, ctx) {
    /**
     * Reject malformed or reversed period bounds before any upstream call.
     * periodSpan() returns null for unrecognized input; the per-observation
     * filter treats null as "don't filter", but as INPUT a null bound must be
     * fatal. Period filtering is client-side (IMF ignores startPeriod/endPeriod),
     * so rejecting known-bad input early is free and skips a wasted round-trip.
     */
    const startSpan = input.start_period ? periodSpan(input.start_period) : null;
    const endSpan = input.end_period ? periodSpan(input.end_period) : null;

    if (input.start_period && startSpan === null) {
      throw ctx.fail(
        'invalid_period_format',
        `start_period '${input.start_period}' is not a recognized period format (expected YYYY, YYYY-SN, YYYY-QN, YYYY-MM, or YYYY-MM-DD)`,
        { field: 'start_period', value: input.start_period },
      );
    }
    if (input.end_period && endSpan === null) {
      throw ctx.fail(
        'invalid_period_format',
        `end_period '${input.end_period}' is not a recognized period format (expected YYYY, YYYY-SN, YYYY-QN, YYYY-MM, or YYYY-MM-DD)`,
        { field: 'end_period', value: input.end_period },
      );
    }
    // Reversed only when the whole start period sits after the whole end period,
    // so a mixed-granularity forward range (2023-Q2 → 2023) is not misread as one.
    if (startSpan && endSpan && startSpan.lo > endSpan.hi) {
      throw ctx.fail(
        'invalid_period_range',
        `start_period '${input.start_period}' is after end_period '${input.end_period}' — start_period must be <= end_period`,
        { start_period: input.start_period, end_period: input.end_period },
      );
    }

    const svc = getImfSdmxService();

    // Resolve dataflow
    const dataflow = await svc.findDataflow(input.dataflow_id, input.agency_id, input.version, ctx);
    if (!dataflow) {
      throw ctx.fail('dataflow_not_found', `Dataflow '${input.dataflow_id}' not found`, {
        dataflowId: input.dataflow_id,
      });
    }

    // The catalog spelling — findDataflow resolves dataflow_id case-insensitively,
    // and the portal only answers the exact id.
    const dataflowId = dataflow.id;

    // Get DSD to validate key dimension count
    let structure: Awaited<ReturnType<typeof svc.fetchDataflowStructure>>;
    try {
      structure = await svc.fetchDataflowStructure(
        dataflowId,
        input.agency_id ?? dataflow.agencyId,
        input.version ?? dataflow.version,
        ctx,
      );
    } catch (err: unknown) {
      if (err instanceof McpError && err.data?.reason === 'dataflow_list_unavailable') throw err;
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('not found')) {
        throw ctx.fail('dataflow_not_found', msg);
      }
      throw ctx.fail('structure_unavailable', msg);
    }

    /**
     * The portal matches codes case- and whitespace-sensitively, answering a
     * padded or lowercased code with HTTP 200 and zero series. Trim every
     * position and + member here; the codelist check below restores each code's
     * canonical spelling.
     */
    const keySegments = input.key.split('.').map((segment) =>
      segment
        .split('+')
        .map((member) => member.trim())
        .join('+'),
    );
    const trimmedKey = keySegments.join('.');
    const namePositions = (indexes: number[]) =>
      indexes
        .map((index) => `${index + 1} (${structure.dimensions[index]?.id ?? 'unknown'})`)
        .join(', ');

    // Validate key dimension count
    const expectedDims = structure.dimensions.length;
    if (expectedDims > 0 && keySegments.length !== expectedDims) {
      throw ctx.fail(
        'key_dimension_mismatch',
        `Key has ${keySegments.length} segment(s) but dataflow '${dataflowId}' has ${expectedDims} dimension(s) (${structure.keyFormat})`,
        {
          keySegments: keySegments.length,
          expectedDimensions: expectedDims,
          keyFormat: structure.keyFormat,
        },
      );
    }

    /**
     * Reject blank positions before the data fetch. An empty segment is not a
     * wildcard upstream — it matches zero series and returns HTTP 200, which
     * would surface as a `no_data` blaming the codes. Rejecting names the `*`
     * that does wildcard the position, and keeps a template-substitution slip
     * from silently widening a one-series query to the whole dimension.
     */
    const blankPositions = keySegments.flatMap((segment, index) => (segment === '' ? [index] : []));
    if (blankPositions.length > 0) {
      throw ctx.fail(
        'empty_key_segment',
        `Key '${trimmedKey}' leaves position ${namePositions(blankPositions)} empty. An empty position matches no series — use * to match every code there. Key format: ${structure.keyFormat}`,
        {
          key: trimmedKey,
          emptyPositions: blankPositions.map((index) => index + 1),
          keyFormat: structure.keyFormat,
        },
      );
    }

    /**
     * `*` inside a + list is not a wildcard upstream: the portal drops it and
     * answers for the listed codes alone (USA+* returns USA only), a silent
     * subset of what the caller asked for.
     */
    const wildcardPositions = keySegments.flatMap((segment, index) => {
      const members = segment.split('+');
      return members.length > 1 && members.includes('*') ? [index] : [];
    });
    if (wildcardPositions.length > 0) {
      throw ctx.fail(
        'wildcard_in_code_list',
        `Key '${trimmedKey}' combines * with other codes at position ${namePositions(wildcardPositions)}. The portal ignores * inside a + list and returns only the listed codes — use * alone to match every code there, or list the codes. Key format: ${structure.keyFormat}`,
        {
          key: trimmedKey,
          positions: wildcardPositions.map((index) => index + 1),
          keyFormat: structure.keyFormat,
        },
      );
    }

    /**
     * Resolve every code against its own dimension's codelist before the fetch.
     * An unknown code otherwise comes back as HTTP 200 with zero series and is
     * misdiagnosed as missing coverage. `*`, empty + members, and positions whose
     * codelist resolved empty pass through unchecked.
     */
    const invalidCodes: InvalidKeyCode[] = [];
    const key = keySegments
      .map((segment, index) => {
        const dimension = structure.dimensions[index];
        if (!dimension || dimension.codelist.length === 0) return segment;
        return segment
          .split('+')
          .map((member) => {
            if (member === '' || member === '*') return member;
            const canonical = resolveCode(member, dimension.codelist);
            if (canonical) return canonical;
            const belongsTo = structure.dimensions.find(
              (other) => other !== dimension && resolveCode(member, other.codelist),
            )?.id;
            invalidCodes.push({
              position: index + 1,
              dimension: dimension.id,
              code: member,
              suggestions: nearestCodes(member, dimension.codelist),
              ...(belongsTo ? { belongsTo } : {}),
            });
            return member;
          })
          .join('+');
      })
      .join('.');
    if (invalidCodes.length > 0) {
      throw ctx.fail(
        'invalid_key_code',
        `Key '${trimmedKey}' uses ${invalidCodes.length} code(s) not in the codelist for their position: ${invalidCodes.map(describeInvalidCode).join('; ')}. Key format: ${structure.keyFormat}`,
        { key: trimmedKey, invalidCodes, keyFormat: structure.keyFormat },
      );
    }

    // Fetch data
    // Preserve the service's actual McpError code, reason, retryability, and
    // cause. A data-request failure is not evidence that the DSD was unavailable.
    const fetchObservations = (lastNObservations: number | undefined) =>
      svc.fetchData(
        dataflow.agencyId,
        dataflowId,
        dataflow.version,
        key,
        input.start_period,
        input.end_period,
        ctx,
        ctx.signal,
        lastNObservations,
      );

    /**
     * The portal honors `lastNObservations` per series but ignores the period
     * bounds, so N is forwarded only when no bound is set; with one, the range
     * is applied locally and N selected inside it. The portal also counts null
     * padding toward N, so a series whose last N cells are padding would vanish
     * in the drop below: a forwarded response the drop takes any row from is
     * fetched again in full and selected locally.
     */
    const lastN = input.last_n_observations;
    const forwardedN = input.start_period || input.end_period ? undefined : lastN;
    let queryResult = await fetchObservations(forwardedN);
    let nonPaddingObservations = queryResult.observations.filter((obs) => !isNullPadding(obs));
    if (
      forwardedN !== undefined &&
      nonPaddingObservations.length < queryResult.observations.length
    ) {
      ctx.log.debug('lastNObservations response carried null padding; re-fetching in full', {
        dataflowId,
        key,
        lastN: forwardedN,
      });
      queryResult = await fetchObservations(undefined);
      nonPaddingObservations = queryResult.observations.filter((obs) => !isNullPadding(obs));
    }

    // Apply period filter server-side (startSpan / endSpan validated at handler top).
    const filteredObservations =
      startSpan || endSpan
        ? nonPaddingObservations.filter((obs) => periodInRange(obs.time_period, startSpan, endSpan))
        : nonPaddingObservations;

    /**
     * The requested range emptied a response that did carry data. That is a
     * range problem, not a coverage one, so it gets its own reason and skips the
     * availability probe — listing the codes that do have data would name the
     * very codes the caller used and point the recovery at the wrong input.
     */
    if (filteredObservations.length === 0 && nonPaddingObservations.length > 0) {
      const { first, last } = observedRange(nonPaddingObservations);
      const requested = periodLabel(input.start_period, input.end_period);
      const message =
        `Key '${key}' in '${dataflowId}' has data, but none within the requested range (${requested}). ` +
        `${nonPaddingObservations.length} observation(s) were returned, spanning ${first} – ${last}.`;

      throw ctx.fail('no_data_in_range', message, {
        key,
        dataflowId,
        requested_range: {
          ...(input.start_period ? { start_period: input.start_period } : {}),
          ...(input.end_period ? { end_period: input.end_period } : {}),
        },
        available_range: { first, last },
        excluded_observation_count: nonPaddingObservations.length,
        // The contract's static hint cannot name the window, so this throw-site
        // hint overrides it — the observed range is the whole point here.
        recovery: {
          hint: `The key is valid — data spans ${first} – ${last}. Set start_period/end_period to overlap that window, or omit both for the full series.`,
        },
      });
    }

    // Upstream returned nothing for this key — a coverage question, so enrich
    // with availability to separate "code not covered" from "wrong combination".
    if (filteredObservations.length === 0) {
      // Uses the first dimension code from the key (e.g. "TUR" from "TUR.MFS135.M").
      const firstCode = key.split('.')[0] ?? '';
      const availability = await svc
        .fetchAvailabilityConstraint(dataflow, firstCode, ctx, ctx.signal)
        .catch(() => null);

      /**
       * A key-scoped constraint answers "does this code have series" and nothing
       * more: an uncovered code in a populated dataflow and a dataflow that
       * publishes nothing at all both come back as `series_count: 0` with an
       * empty cube region, byte-identical apart from the ids. Only the
       * dataflow-wide constraint separates them — so ask for it, and only on the
       * path that already has no data to return.
       */
      const dataflowAvailability =
        availability?.series_count === 0
          ? await svc.fetchAvailabilityConstraint(dataflow, '', ctx, ctx.signal).catch(() => null)
          : null;

      let noDataMsg: string;
      let recoveryHint: string | undefined;

      if (
        availability &&
        availability.series_count === 0 &&
        dataflowAvailability?.series_count === 0
      ) {
        // The dataflow itself is empty. Every key returns this, so pointing the
        // caller at a different code is a loop with no exit.
        noDataMsg =
          `Dataflow '${dataflowId}' publishes no series at all — it is empty, so every key ` +
          `returns no data, including this one. Recently added vintage dataflows are commonly empty ` +
          `until the IMF populates them.`;
        recoveryHint =
          `'${dataflowId}' holds no data — changing the key will not help. ` +
          `Call imf_list_databases to pick a different dataflow.`;
      } else if (availability && availability.series_count === 0) {
        // The code is uncovered inside a dataflow that does publish series. When
        // the dataflow-wide constraint came back, it names codes that do have
        // data — the correction the old "try a different code" hint never gave.
        const coverage = dataflowAvailability
          ? describeCoverage(dataflowAvailability.available_codes)
          : '';
        const coverageLine = coverage ? ` Codes with data in this dataflow: ${coverage}.` : '';
        const totalLine = dataflowAvailability
          ? ` The dataflow itself publishes ${dataflowAvailability.series_count} series.`
          : '';
        noDataMsg =
          `'${firstCode}' has 0 series in '${dataflowId}' — ` +
          `this code has no coverage in this dataflow.${totalLine} ` +
          `Coverage is narrower than the codelist; check availability rather than the codelist to pick codes.${coverageLine}`;
        recoveryHint =
          `'${firstCode}' is not covered in '${dataflowId}'. ` +
          `Try a different code — the codelist may include codes with no actual data.${coverageLine}`;
      } else if (availability) {
        // A capped dimension states how many of how many it is showing —
        // an unannotated slice reads as the full set (see AvailabilityDimension).
        const dimLines = describeCoverage(availability.available_codes);
        const timeLine =
          availability.time_period_start || availability.time_period_end
            ? ` Available time range: ${availability.time_period_start ?? '?'} – ${availability.time_period_end ?? '?'}.`
            : '';
        noDataMsg =
          `No data for key '${key}' in '${dataflowId}' ` +
          `(${availability.series_count} series exist for '${firstCode}', but this combination has none). ` +
          `Available codes per dimension: ${dimLines}.${timeLine}`;
        recoveryHint =
          `The combination is wrong — '${firstCode}' has ${availability.series_count} series but not for this key. ` +
          `Available codes: ${dimLines}.${timeLine}`;
      } else {
        noDataMsg = `No data returned for key '${key}' in dataflow '${dataflowId}'`;
      }

      throw ctx.fail('no_data', noDataMsg, {
        key,
        dataflowId,
        ...(availability ? { availability } : {}),
        ...(dataflowAvailability ? { dataflow_availability: dataflowAvailability } : {}),
        ...(recoveryHint ? { recovery: { hint: recoveryHint } } : {}),
      });
    }

    /**
     * Selected after the emptiness checks, so they see exactly the set they see
     * without N, and N ≥ 1 never empties a series that has observations.
     */
    const selectedObservations =
      lastN === undefined ? filteredObservations : lastNPerSeries(filteredObservations, lastN);

    /**
     * A label periodSpan() cannot read is returned rather than dropped — dropping
     * data over an unknown label shape is worse than ignoring the bound for it.
     * But leaving that silent is how a coarse bound quietly dropped a whole year
     * before, so say it: the response would otherwise echo a range it did not
     * apply to these rows.
     */
    let periodNotice: string | undefined;
    if (startSpan || endSpan) {
      const unrecognized = selectedObservations.filter(
        (obs) => periodSpan(obs.time_period) === null,
      );
      if (unrecognized.length > 0) {
        const samples = [...new Set(unrecognized.map((obs) => obs.time_period))].slice(0, 3);
        periodNotice =
          `${unrecognized.length} observation(s) carry a period label this tool cannot parse (${samples.join(', ')}), ` +
          `so start_period/end_period were not applied to them and they are returned unfiltered.`;
        ctx.enrich.notice(periodNotice);
      }
    }

    /**
     * Attributes belong to a series, not to a query. Everything downstream — the
     * inline payload, the canvas rows, the rendered text — reads them through
     * this lookup so a row can only ever receive its own series' unit and scale.
     * The flat fallback covers a series the upstream payload described no
     * attributes for.
     */
    const attributesFor = (seriesKey: string): SeriesAttributes =>
      queryResult.seriesAttributesByKey[seriesKey] ?? queryResult.seriesAttributes;

    const seriesKeys = [...new Set(selectedObservations.map((obs) => obs.series_key))];
    // One series needs no per-series list — series_attributes already describes it.
    const seriesMetadata =
      seriesKeys.length > 1
        ? seriesKeys.map((seriesKey) => {
            const attrs = attributesFor(seriesKey);
            return {
              series_key: seriesKey,
              unit: attrs.unit,
              scale: attrs.scale,
              decimals: attrs.decimals,
            };
          })
        : undefined;

    /**
     * The flat field is pinned to the first series of the result rather than the
     * first the decoder happened to reach, so `series_attributes` and
     * `series_metadata[0]` always describe the same series. Observations are
     * time-sorted, so the two orders are otherwise unrelated — and a flat record
     * that silently belongs to a different series than the list's head is the
     * same class of confusion the per-series list exists to end.
     */
    const primarySeriesKey = seriesKeys[0];
    const seriesAttributes = primarySeriesKey
      ? attributesFor(primarySeriesKey)
      : queryResult.seriesAttributes;

    ctx.log.info('Data query completed', {
      dataflowId,
      key,
      observations: selectedObservations.length,
      series: seriesKeys.length,
    });

    const source = `Source: International Monetary Fund, ${dataflow.name}, ${IMF_DATA_PORTAL}`;
    const base = {
      dataflow_id: dataflowId,
      key,
      ...(input.start_period ? { start_period: input.start_period } : {}),
      ...(input.end_period ? { end_period: input.end_period } : {}),
      ...(lastN !== undefined ? { last_n_observations: lastN } : {}),
      series_attributes: seriesAttributes,
      ...(seriesMetadata ? { series_metadata: seriesMetadata } : {}),
      observation_count: selectedObservations.length,
      source,
    };

    const inlineResult = {
      ...base,
      observations: selectedObservations,
      staged: false,
      truncated: false,
    } satisfies QueryDatasetResult;

    // Canvas stage/spill path
    const canvas = getCanvas();
    if (input.output_mode === 'canvas' && !canvas) {
      throw ctx.fail(
        'canvas_unavailable',
        'output_mode="canvas" requires DataCanvas, but no canvas provider is configured',
      );
    }
    const explicit = input.output_mode === 'canvas';
    if (!explicit && serializedResultChars(inlineResult, periodNotice) <= RESPONSE_BUDGET_CHARS) {
      return inlineResult;
    }

    /** A key whose fixed metadata alone overflows fails rather than dropping the series inventory. */
    const tooLarge = (fixedChars: number, fixedPart: string) =>
      ctx.fail(
        'response_too_large',
        `${fixedPart} ${fixedChars} serialized characters before any observation (budget ${RESPONSE_BUDGET_CHARS}).`,
        {
          seriesCount: seriesKeys.length,
          serializedChars: fixedChars,
          budgetChars: RESPONSE_BUDGET_CHARS,
        },
      );

    // Without a canvas an over-budget result is cut the same way, minus the handle.
    if (!canvas) {
      const fitted = fitToBudget(
        (count) => {
          const observations = selectedObservations.slice(0, count);
          return {
            ...base,
            observations,
            staged: false,
            truncated: count < selectedObservations.length,
            retrieval_guidance: inlineTruncationGuidance(observations, selectedObservations.length),
          };
        },
        selectedObservations.length,
        periodNotice,
      );
      if ('fixedChars' in fitted) {
        throw tooLarge(fitted.fixedChars, "The result's full series metadata requires");
      }
      return fitted.result;
    }

    const instance = await canvas.acquire(input.canvas_id, ctx);
    const tableName = `imf_${idGenerator.generateRandomString(8, TABLE_NAME_CHARS)}`;
    const stageGuidance =
      'The complete result is staged on DataCanvas. Call imf_dataframe_describe with canvas_id first to inspect tables and columns, then call imf_dataframe_query with canvas_id and SQL against table_name.';
    const stagedBase = {
      ...base,
      staged: true,
      canvas_id: instance.canvasId,
      table_name: tableName,
      retrieval_guidance: stageGuidance,
    };

    const fitted = fitToBudget(
      (count) => ({
        ...stagedBase,
        observations: selectedObservations.slice(0, count),
        truncated: count < selectedObservations.length,
      }),
      selectedObservations.length,
      periodNotice,
    );
    if ('fixedChars' in fitted) {
      throw tooLarge(
        fitted.fixedChars,
        "The staged result's full series metadata and retrieval handle require",
      );
    }

    /**
     * Column types are declared, not sniffed. Left to the framework, a column is
     * typed from the first 100 rows, and rows stage time-ascending: a rate pegged
     * at 1 for its first 100 months typed `value` BIGINT and truncated every later
     * fraction, and a lead of null values kept for their status typed it VARCHAR.
     * One entry per field of the row mapping below, in the same order.
     */
    const schema: ColumnSchema[] = [
      { name: 'dataflow_id', type: 'VARCHAR' },
      { name: 'series_key', type: 'VARCHAR' },
      { name: 'time_period', type: 'VARCHAR' },
      { name: 'value', type: 'DOUBLE' },
      { name: 'status', type: 'VARCHAR' },
      { name: 'unit', type: 'VARCHAR' },
      { name: 'scale', type: 'VARCHAR' },
      { name: 'decimals', type: 'INTEGER' },
    ];
    const rows = selectedObservations.map((obs) => {
      const attrs = attributesFor(obs.series_key);
      return {
        dataflow_id: dataflowId,
        series_key: obs.series_key,
        time_period: obs.time_period,
        value: obs.value,
        status: obs.status,
        unit: attrs.unit,
        scale: attrs.scale,
        decimals: attrs.decimals,
      };
    });
    await instance.registerTable(tableName, rows, { schema, signal: ctx.signal });

    return fitted.result;
  },

  format: formatQueryDataset,
});
