/**
 * @fileoverview Tool: imf_query_dataset — query a dataflow by dimension key over a time range.
 * Periods are compared as the date spans they name, so a bound coarser than the
 * observation frequency covers every sub-period inside it. Large result sets
 * spill to DataCanvas for SQL analysis.
 * @module mcp-server/tools/definitions/imf-query-dataset.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { spillover } from '@cyanheads/mcp-ts-core/canvas';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getCanvas } from '@/services/canvas/canvas-accessor.js';
import { getImfSdmxService } from '@/services/imf-sdmx/imf-sdmx-service.js';
import type { Observation } from '@/services/imf-sdmx/types.js';

const PREVIEW_CHARS = 100_000;

/** IMF SDMX 3.0 data portal base URL — used to construct per-dataflow attribution links. */
const IMF_DATA_PORTAL = 'https://data.imf.org/';

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
    const month = Number(daily[2]);
    const day = Number(daily[3]);
    if (month < 1 || month > 12 || day < 1 || day > LAST_DAY) return null;
    const key = dateKey(Number(daily[1]), month, day);
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

export const imfQueryDataset = tool('imf_query_dataset', {
  description:
    'Query an IMF SDMX dataflow by dimension key over a time range. ' +
    'Returns observations with time_period, value, unit, scale, and status attributes. ' +
    'Requires imf_get_database first to obtain the correct key_format and valid dimension codes. ' +
    'Country codes are ISO 3-letter (USA, GBR, DEU — not US, GB, DE). ' +
    'Key format: dot-separated codes in DSD keyPosition order (e.g. USA.NGDP_RPCH.A for WEO). ' +
    'Every position must carry a code: use + to combine codes (e.g. USA+GBR.NGDP_RPCH.A) ' +
    'and * to match every code at a position (e.g. *.NGDP_RPCH.A for all countries). ' +
    'Codelists from imf_get_database enumerate the code universe, not actual coverage — ' +
    'valid codes can still return no_data if the combination has no series. ' +
    'start_period and end_period must be valid period strings (YYYY, YYYY-SN, YYYY-QN, ' +
    'YYYY-MM, or YYYY-MM-DD) with start_period no later than end_period; malformed or ' +
    'reversed ranges are rejected. ' +
    'A bound covers the whole period it names, so end_period 2023 includes 2023-M12 and 2023-Q4. ' +
    'Large analytical result sets (multi-country, long time range) spill to DataCanvas; ' +
    'imf_dataframe_query provides SQL analysis of spilled results.',
  annotations: {
    readOnlyHint: true,
    idempotentHint: true,
    openWorldHint: true,
  },
  input: z.object({
    dataflow_id: z
      .string()
      .describe('Dataflow identifier from imf_list_databases, e.g. WEO, BOP, CPI.'),
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
          'Country codes are ISO 3-letter: USA not US, GBR not GB, DEU not DE.',
      ),
    start_period: z
      .string()
      .optional()
      .describe(
        'Start of time range (inclusive). Accepts any of YYYY (annual), ' +
          'YYYY-SN (semi-annual, e.g. 2023-S1), YYYY-QN (quarterly, e.g. 2023-Q1), ' +
          'YYYY-MM (monthly), or YYYY-MM-DD (daily), whatever the ' +
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
    canvas_id: z
      .string()
      .optional()
      .describe(
        'Existing canvas ID to accumulate results into across multiple queries. ' +
          'Omit to allocate a fresh canvas; the response includes a canvas_id when results spill to DataCanvas.',
      ),
  }),
  output: z.object({
    dataflow_id: z.string().describe('Dataflow identifier that was queried, e.g. WEO.'),
    key: z.string().describe('Dimension key used in the query, e.g. USA.NGDP_RPCH.A.'),
    start_period: z
      .string()
      .optional()
      .describe('Earliest period covered; absent when the full available range was used.'),
    end_period: z
      .string()
      .optional()
      .describe('Latest period covered; absent when the full available range was used.'),
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
            value: z.number().nullable().describe('Observation value, null when missing.'),
            status: z
              .string()
              .nullable()
              .describe('Observation status flag, e.g. E (estimate) or null when absent.'),
          })
          .describe('A single time-series observation.'),
      )
      .describe(
        'Inline observations. Empty when results spilled to canvas (see canvas_id / table_name).',
      ),
    series_attributes: z
      .object({
        unit: z.string().nullable().describe('Unit of measure, e.g. Percent, USD.'),
        scale: z.string().nullable().describe('Scale multiplier, e.g. Billions.'),
        decimals: z.number().nullable().describe('Number of decimal places shown.'),
      })
      .describe('Series-level attributes (unit, scale, decimals).'),
    observation_count: z.number().describe('Total observations in the result.'),
    truncated: z
      .boolean()
      .describe(
        'True when the result exceeded the inline limit and was staged on a DataCanvas table; ' +
          'canvas_id and table_name are populated and imf_dataframe_query provides SQL access to the full set.',
      ),
    canvas_id: z
      .string()
      .optional()
      .describe(
        'DataCanvas session ID — present when truncated=true. ' +
          'Pass to imf_dataframe_query or imf_dataframe_describe to query the full result.',
      ),
    table_name: z
      .string()
      .optional()
      .describe(
        'DuckDB table name on the canvas — present when truncated=true; reference in SQL via FROM <table_name>.',
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
      recovery: 'Call imf_list_databases to browse available dataflow IDs.',
    },
    {
      reason: 'no_data',
      code: JsonRpcErrorCode.NotFound,
      when: 'Key is structurally valid but the dataflow holds no series for this code combination',
      recovery:
        'Check the availability context in the error — if series_count is 0 the code has no coverage; if series_count > 0 the combination is wrong and available_codes names the codes that do have data, stating how many of a dimension it is showing when the list is capped.',
    },
    {
      reason: 'no_data_in_range',
      code: JsonRpcErrorCode.NotFound,
      when: 'The key returned observations but start_period/end_period excluded every one of them',
      recovery:
        'The key is valid — widen start_period/end_period to overlap the period range reported in the error, or omit both to get the full series.',
    },
    {
      reason: 'key_dimension_mismatch',
      code: JsonRpcErrorCode.ValidationError,
      when: "Number of dot-separated segments in key does not match the dataflow's DSD dimension count",
      recovery:
        'Call imf_get_database to get the correct key_format for this dataflow, then reconstruct the key.',
    },
    {
      reason: 'empty_key_segment',
      code: JsonRpcErrorCode.ValidationError,
      when: 'A dot-separated position in key is empty or blank, which matches no series upstream',
      recovery:
        'Put * at that position to match every code there, or a code from imf_get_database to pin it.',
    },
    {
      reason: 'invalid_period_format',
      code: JsonRpcErrorCode.ValidationError,
      when: 'start_period or end_period is not one of the recognized period formats',
      recovery:
        'Use YYYY (annual), YYYY-SN (semi-annual), YYYY-QN (quarterly, e.g. 2023-Q1), YYYY-MM (monthly), or YYYY-MM-DD (daily).',
    },
    {
      reason: 'invalid_period_range',
      code: JsonRpcErrorCode.ValidationError,
      when: 'start_period is later than end_period',
      recovery: 'Provide start_period less than or equal to end_period (chronological order).',
    },
    {
      reason: 'structure_unavailable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'api.imf.org returns non-200 on the data endpoint',
      recovery: 'Retry after a short wait.',
    },
    {
      reason: 'dataflow_list_unavailable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'The dataflow catalog that dataflow_id is resolved against could not be fetched — fires before the DSD and data lookups are attempted',
      retryable: true,
      recovery:
        'Retry in a few moments; the IMF SDMX 3.0 portal is intermittently unavailable and the catalog is cached for an hour once it succeeds.',
    },
  ],

  enrichment: {
    notice: z
      .string()
      .optional()
      .describe(
        'Populated when a period bound was set but some observations carry a time_period label ' +
          'the range filter does not recognize — those rows are returned unfiltered, so the ' +
          'requested range did not apply to them.',
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
        {
          field: 'start_period',
          value: input.start_period,
          ...ctx.recoveryFor('invalid_period_format'),
        },
      );
    }
    if (input.end_period && endSpan === null) {
      throw ctx.fail(
        'invalid_period_format',
        `end_period '${input.end_period}' is not a recognized period format (expected YYYY, YYYY-SN, YYYY-QN, YYYY-MM, or YYYY-MM-DD)`,
        {
          field: 'end_period',
          value: input.end_period,
          ...ctx.recoveryFor('invalid_period_format'),
        },
      );
    }
    // Reversed only when the whole start period sits after the whole end period,
    // so a mixed-granularity forward range (2023-Q2 → 2023) is not misread as one.
    if (startSpan && endSpan && startSpan.lo > endSpan.hi) {
      throw ctx.fail(
        'invalid_period_range',
        `start_period '${input.start_period}' is after end_period '${input.end_period}' — start_period must be <= end_period`,
        {
          start_period: input.start_period,
          end_period: input.end_period,
          ...ctx.recoveryFor('invalid_period_range'),
        },
      );
    }

    const svc = getImfSdmxService();

    // Resolve dataflow
    const dataflow = await svc.findDataflow(input.dataflow_id, input.agency_id, input.version, ctx);
    if (!dataflow) {
      throw ctx.fail('dataflow_not_found', `Dataflow '${input.dataflow_id}' not found`, {
        dataflowId: input.dataflow_id,
        ...ctx.recoveryFor('dataflow_not_found'),
      });
    }

    // Get DSD to validate key dimension count
    let structure: Awaited<ReturnType<typeof svc.fetchDataflowStructure>>;
    try {
      structure = await svc.fetchDataflowStructure(
        input.dataflow_id,
        input.agency_id ?? dataflow.agencyId,
        input.version ?? dataflow.version,
        ctx,
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('not found')) {
        throw ctx.fail('dataflow_not_found', msg, ctx.recoveryFor('dataflow_not_found'));
      }
      throw ctx.fail('structure_unavailable', msg, ctx.recoveryFor('structure_unavailable'));
    }

    // Validate key dimension count
    const expectedDims = structure.dimensions.length;
    const keySegments = input.key.split('.');
    if (expectedDims > 0 && keySegments.length !== expectedDims) {
      throw ctx.fail(
        'key_dimension_mismatch',
        `Key has ${keySegments.length} segment(s) but dataflow '${input.dataflow_id}' has ${expectedDims} dimension(s) (${structure.keyFormat})`,
        {
          keySegments: keySegments.length,
          expectedDimensions: expectedDims,
          keyFormat: structure.keyFormat,
          ...ctx.recoveryFor('key_dimension_mismatch'),
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
    const blankPositions = keySegments.flatMap((segment, index) =>
      segment.trim() === '' ? [index] : [],
    );
    if (blankPositions.length > 0) {
      const named = blankPositions
        .map((index) => `${index + 1} (${structure.dimensions[index]?.id ?? 'unknown'})`)
        .join(', ');
      throw ctx.fail(
        'empty_key_segment',
        `Key '${input.key}' leaves position ${named} empty. An empty position matches no series — use * to match every code there. Key format: ${structure.keyFormat}`,
        {
          key: input.key,
          emptyPositions: blankPositions.map((index) => index + 1),
          keyFormat: structure.keyFormat,
          ...ctx.recoveryFor('empty_key_segment'),
        },
      );
    }

    // Fetch data
    let queryResult: Awaited<ReturnType<typeof svc.fetchData>>;
    try {
      queryResult = await svc.fetchData(
        dataflow.agencyId,
        input.dataflow_id,
        dataflow.version,
        input.key,
        input.start_period,
        input.end_period,
        ctx,
        ctx.signal,
      );
    } catch {
      throw ctx.fail(
        'structure_unavailable',
        `IMF SDMX data endpoint unavailable for dataflow '${input.dataflow_id}'`,
        ctx.recoveryFor('structure_unavailable'),
      );
    }

    // Drop null-value padding rows (value=null AND status=null).
    // Calendar-padded series carry these for periods before data starts; they add no information.
    // Keep rows where status is non-null even if value is null — those are official missing-value markers.
    const nonPaddingObservations = queryResult.observations.filter(
      (obs) => obs.value !== null || obs.status !== null,
    );

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
      const requested = [input.start_period, input.end_period].filter(Boolean).join(' – ');
      const message =
        `Key '${input.key}' in '${input.dataflow_id}' has data, but none within the requested range (${requested}). ` +
        `${nonPaddingObservations.length} observation(s) were returned, spanning ${first} – ${last}.`;

      throw ctx.fail('no_data_in_range', message, {
        key: input.key,
        dataflowId: input.dataflow_id,
        requested_range: {
          ...(input.start_period ? { start_period: input.start_period } : {}),
          ...(input.end_period ? { end_period: input.end_period } : {}),
        },
        available_range: { first, last },
        excluded_observation_count: nonPaddingObservations.length,
        // The contract's static hint cannot name the window, so it is replaced
        // rather than spread — the observed range is the whole point here.
        recovery: {
          hint: `The key is valid — data spans ${first} – ${last}. Set start_period/end_period to overlap that window, or omit both for the full series.`,
        },
      });
    }

    // Upstream returned nothing for this key — a coverage question, so enrich
    // with availability to separate "code not covered" from "wrong combination".
    if (filteredObservations.length === 0) {
      // Uses the first dimension code from the key (e.g. "TUR" from "TUR.MFS135.M").
      const firstCode = input.key.split('.')[0] ?? '';
      const availability = await svc
        .fetchAvailabilityConstraint(input.dataflow_id, firstCode, ctx, ctx.signal)
        .catch(() => null);

      let noDataMsg: string;
      let recoveryHint: string | undefined;

      if (availability) {
        if (availability.series_count === 0) {
          noDataMsg =
            `'${firstCode}' has 0 series in '${input.dataflow_id}' — ` +
            `this code has no coverage in this dataflow. ` +
            `Coverage is narrower than the codelist; check availability rather than the codelist to pick codes.`;
          recoveryHint =
            `'${firstCode}' is not covered in '${input.dataflow_id}'. ` +
            `Try a different code — the codelist may include codes with no actual data.`;
        } else {
          // A capped dimension states how many of how many it is showing —
          // an unannotated slice reads as the full set (see AvailabilityDimension).
          const dimLines = Object.entries(availability.available_codes)
            .map(([dim, { codes, count }]) =>
              count > codes.length
                ? `${dim}: ${codes.length} of ${count} codes with data shown (${codes.join(', ')})`
                : `${dim}: ${codes.join(', ')}`,
            )
            .join('; ');
          const timeLine =
            availability.time_period_start || availability.time_period_end
              ? ` Available time range: ${availability.time_period_start ?? '?'} – ${availability.time_period_end ?? '?'}.`
              : '';
          noDataMsg =
            `No data for key '${input.key}' in '${input.dataflow_id}' ` +
            `(${availability.series_count} series exist for '${firstCode}', but this combination has none). ` +
            `Available codes per dimension: ${dimLines}.${timeLine}`;
          recoveryHint =
            `The combination is wrong — '${firstCode}' has ${availability.series_count} series but not for this key. ` +
            `Available codes: ${dimLines}.${timeLine}`;
        }
      } else {
        noDataMsg = `No data returned for key '${input.key}' in dataflow '${input.dataflow_id}'`;
      }

      throw ctx.fail('no_data', noDataMsg, {
        key: input.key,
        dataflowId: input.dataflow_id,
        ...(availability ? { availability } : {}),
        ...ctx.recoveryFor('no_data'),
        ...(recoveryHint ? { recovery: { hint: recoveryHint } } : {}),
      });
    }

    /**
     * A label periodSpan() cannot read is returned rather than dropped — dropping
     * data over an unknown label shape is worse than ignoring the bound for it.
     * But leaving that silent is how a coarse bound quietly dropped a whole year
     * before, so say it: the response would otherwise echo a range it did not
     * apply to these rows.
     */
    if (startSpan || endSpan) {
      const unrecognized = filteredObservations.filter(
        (obs) => periodSpan(obs.time_period) === null,
      );
      if (unrecognized.length > 0) {
        const samples = [...new Set(unrecognized.map((obs) => obs.time_period))].slice(0, 3);
        ctx.enrich.notice(
          `${unrecognized.length} observation(s) carry a period label this tool cannot parse (${samples.join(', ')}), ` +
            `so start_period/end_period were not applied to them and they are returned unfiltered.`,
        );
      }
    }

    ctx.log.info('Data query completed', {
      dataflowId: input.dataflow_id,
      key: input.key,
      observations: filteredObservations.length,
    });

    // Canvas spill path
    const canvas = getCanvas();
    if (canvas) {
      const instance = await canvas.acquire(input.canvas_id, ctx);
      const rows = filteredObservations.map((obs) => ({
        dataflow_id: input.dataflow_id,
        series_key: obs.series_key,
        time_period: obs.time_period,
        value: obs.value,
        status: obs.status,
        unit: queryResult.seriesAttributes.unit,
        scale: queryResult.seriesAttributes.scale,
        decimals: queryResult.seriesAttributes.decimals,
      }));

      const result = await spillover({
        canvas: instance,
        source: rows,
        previewChars: PREVIEW_CHARS,
        signal: ctx.signal,
      });

      if (result.spilled) {
        return {
          dataflow_id: input.dataflow_id,
          key: input.key,
          ...(input.start_period ? { start_period: input.start_period } : {}),
          ...(input.end_period ? { end_period: input.end_period } : {}),
          observations: result.previewRows.map((r) => ({
            series_key: r.series_key,
            time_period: r.time_period,
            value: r.value,
            status: r.status,
          })),
          series_attributes: queryResult.seriesAttributes,
          observation_count: result.handle.rowCount,
          truncated: true,
          canvas_id: instance.canvasId,
          table_name: result.handle.tableName,
          source: `Source: International Monetary Fund, ${dataflow.name}, ${IMF_DATA_PORTAL}`,
        };
      }
    }

    // Inline path (no canvas, or result fit in preview)
    return {
      dataflow_id: input.dataflow_id,
      key: input.key,
      ...(input.start_period ? { start_period: input.start_period } : {}),
      ...(input.end_period ? { end_period: input.end_period } : {}),
      observations: filteredObservations,
      series_attributes: queryResult.seriesAttributes,
      observation_count: filteredObservations.length,
      truncated: false,
      source: `Source: International Monetary Fund, ${dataflow.name}, ${IMF_DATA_PORTAL}`,
    };
  },

  format: (result) => {
    const lines: string[] = [];
    lines.push(`## IMF Data: ${result.dataflow_id} — \`${result.key}\``);

    if (result.start_period || result.end_period) {
      const range = [result.start_period, result.end_period].filter(Boolean).join(' – ');
      lines.push(`**Period:** ${range}`);
    }

    const { unit, scale, decimals } = result.series_attributes;
    // Suppress scale "0" — it's a no-op multiplier the upstream API emits when
    // scale is absent; printing "0" is misleading.
    const meaningfulScale = scale && scale !== '0' ? scale : null;
    if (unit || meaningfulScale) {
      const meta = [unit, meaningfulScale, decimals != null ? `${decimals} decimals` : null]
        .filter(Boolean)
        .join(' | ');
      lines.push(`**Series:** ${meta}`);
    }

    lines.push(
      `**Observations:** ${result.observation_count} | **Truncated:** ${result.truncated}`,
    );

    if (result.truncated) {
      lines.push(
        `\n> Result exceeds inline limit. Full dataset staged on canvas.` +
          `\n> **Canvas ID:** \`${result.canvas_id}\`` +
          `\n> **Table:** \`${result.table_name}\`` +
          `\n> Use \`imf_dataframe_describe\` then \`imf_dataframe_query\` to analyze.`,
      );
    }

    if (result.observations.length > 0) {
      lines.push('\n| Series Key | Time Period | Value | Status |');
      lines.push('|:-----------|:------------|------:|:-------|');
      for (const obs of result.observations) {
        const val = obs.value != null ? obs.value.toString() : '—';
        const status = obs.status ?? '—';
        lines.push(`| ${obs.series_key} | ${obs.time_period} | ${val} | ${status} |`);
      }
    }

    lines.push(`\n_${result.source}_`);

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
