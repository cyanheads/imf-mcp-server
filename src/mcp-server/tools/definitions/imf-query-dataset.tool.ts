/**
 * @fileoverview Tool: imf_query_dataset — query a dataflow by dimension key over a time range.
 * Large result sets spill to DataCanvas for SQL analysis.
 * @module mcp-server/tools/definitions/imf-query-dataset.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { spillover } from '@cyanheads/mcp-ts-core/canvas';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getCanvas } from '@/services/canvas/canvas-accessor.js';
import { getImfSdmxService } from '@/services/imf-sdmx/imf-sdmx-service.js';

const PREVIEW_CHARS = 100_000;

/** IMF SDMX 3.0 data portal base URL — used to construct per-dataflow attribution links. */
const IMF_DATA_PORTAL = 'https://data.imf.org/';

/**
 * Normalize a period string to a canonical comparable form.
 * Supports:
 *   Annual:      "YYYY"        → "YYYY"
 *   Quarterly:   "YYYY-QN"     → "YYYY-QN"
 *   Monthly:     "YYYY-MM"     → "YYYY-MM" (input format)
 *   Monthly:     "YYYY-MNN"    → "YYYY-MM" (upstream format, e.g. "1956-M01" → "1956-01")
 * Returns null for unrecognized formats (those observations are not filtered out).
 */
function normalizePeriod(period: string): string | null {
  // Annual: "2023"
  if (/^\d{4}$/.test(period)) return period;
  // Quarterly: "2023-Q1"
  if (/^\d{4}-Q\d$/.test(period)) return period;
  // Monthly YYYY-MM (input format)
  if (/^\d{4}-\d{2}$/.test(period)) return period;
  // Monthly YYYY-MNN (upstream format, e.g. "1956-M01", "2023-M12")
  const mMatch = /^(\d{4})-M(\d{1,2})$/.exec(period);
  if (mMatch) {
    const [, year, month] = mMatch;
    return `${year}-${month?.padStart(2, '0')}`;
  }
  return null;
}

/** Return true if observation period falls within [start, end] (both inclusive, either optional). */
function periodInRange(
  timePeriod: string,
  startNorm: string | null | undefined,
  endNorm: string | null | undefined,
): boolean {
  if (!startNorm && !endNorm) return true;
  const norm = normalizePeriod(timePeriod);
  if (!norm) return true; // unrecognized format — don't filter
  if (startNorm && norm < startNorm) return false;
  if (endNorm && norm > endNorm) return false;
  return true;
}

export const imfQueryDataset = tool('imf_query_dataset', {
  description:
    'Query an IMF SDMX dataflow by dimension key over a time range. ' +
    'Returns observations with time_period, value, unit, scale, and status attributes. ' +
    'Requires imf_get_database first to obtain the correct key_format and valid dimension codes. ' +
    'Country codes are ISO 3-letter (USA, GBR, DEU — not US, GB, DE). ' +
    'Key format: dot-separated codes in DSD keyPosition order (e.g. USA.NGDP_RPCH.A for WEO). ' +
    'Use + to specify multiple codes per position (e.g. USA+GBR.NGDP_RPCH.A). ' +
    'Codelists from imf_get_database enumerate the code universe, not actual coverage — ' +
    'valid codes can still return no_data if the combination has no series. ' +
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
          'Use + to specify multiple codes (e.g. USA+GBR.NGDP_RPCH.A). ' +
          'Country codes are ISO 3-letter: USA not US, GBR not GB, DEU not DE.',
      ),
    start_period: z
      .string()
      .optional()
      .describe(
        'Start of time range (inclusive). Format matches the dataflow frequency: ' +
          'YYYY (annual), YYYY-QN (quarterly, e.g. 2023-Q1), YYYY-MM (monthly). ' +
          'Observations before this period are excluded from the result.',
      ),
    end_period: z
      .string()
      .optional()
      .describe(
        'End of time range (inclusive). Same format as start_period. ' +
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
                  'Quarterly: YYYY-QN (e.g. 2023-Q1). Monthly: YYYY-MNN (e.g. 2023-M01, not YYYY-MM). ' +
                  'start_period/end_period accept both YYYY-MM and YYYY-MNN for monthly comparisons.',
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
      when: 'Key is structurally valid but returns an empty dataset — either the code combination has no series in this dataflow, or the time range is outside available coverage',
      recovery:
        'Check the availability context in the error — if series_count is 0 the code has no coverage; if series_count > 0 the combination is wrong and available_codes lists what does have data.',
    },
    {
      reason: 'key_dimension_mismatch',
      code: JsonRpcErrorCode.ValidationError,
      when: "Number of dot-separated segments in key does not match the dataflow's DSD dimension count",
      recovery:
        'Call imf_get_database to get the correct key_format for this dataflow, then reconstruct the key.',
    },
    {
      reason: 'structure_unavailable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'api.imf.org returns non-200 on the data endpoint',
      recovery: 'Retry after a short wait.',
    },
  ],

  async handler(input, ctx) {
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

    // Apply period filter server-side before canvas spill.
    const startNorm = input.start_period ? normalizePeriod(input.start_period) : null;
    const endNorm = input.end_period ? normalizePeriod(input.end_period) : null;
    const filteredObservations =
      startNorm || endNorm
        ? nonPaddingObservations.filter((obs) => periodInRange(obs.time_period, startNorm, endNorm))
        : nonPaddingObservations;

    // Detect empty result (after null-padding removal and period filtering)
    if (filteredObservations.length === 0) {
      // Enrich the error with availability info so the caller can distinguish
      // "code not covered" from "valid code, wrong combination".
      // Uses the first dimension code from the key (e.g. "TUR" from "TUR.MFS135..M").
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
          const dimLines = Object.entries(availability.available_codes)
            .map(([dim, codes]) => `${dim}: ${codes.join(', ')}`)
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
