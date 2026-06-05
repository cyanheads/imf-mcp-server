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

export const imfQueryDataset = tool('imf_query_dataset', {
  description:
    'Query an IMF SDMX dataflow by dimension key over a time range. ' +
    'Returns observations with time_period, value, unit, scale, and status attributes. ' +
    'Requires imf_get_database first to obtain the correct key_format and valid dimension codes. ' +
    'Country codes are ISO 3-letter (USA, GBR, DEU — not US, GB, DE). ' +
    'Key format: dot-separated codes in DSD keyPosition order (e.g. USA.NGDP_RPCH.A for WEO). ' +
    'Use + to specify multiple codes per position (e.g. USA+GBR.NGDP_RPCH.A). ' +
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
        'Start of time range. Format matches the dataflow frequency: ' +
          'YYYY (annual), YYYY-QN (quarterly, e.g. 2023-Q1), YYYY-MM (monthly). ' +
          'Omit to use the full available range.',
      ),
    end_period: z
      .string()
      .optional()
      .describe(
        'End of time range. Same format as start_period. Omit for the full available range.',
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
            time_period: z.string().describe('Time label, e.g. 2023 or 2023-Q1 or 2023-01.'),
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
      when: 'Key is structurally valid but returns an empty dataset — typically an unknown dimension code or no data for the time range',
      recovery:
        'Verify dimension codes with imf_get_database; check that start_period/end_period overlap available data.',
    },
    {
      reason: 'key_dimension_mismatch',
      code: JsonRpcErrorCode.InvalidParams,
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
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw ctx.fail('structure_unavailable', msg, ctx.recoveryFor('structure_unavailable'));
    }

    // Detect empty result
    if (queryResult.observations.length === 0) {
      throw ctx.fail(
        'no_data',
        `No data returned for key '${input.key}' in dataflow '${input.dataflow_id}'`,
        {
          key: input.key,
          dataflowId: input.dataflow_id,
          ...ctx.recoveryFor('no_data'),
        },
      );
    }

    ctx.log.info('Data query completed', {
      dataflowId: input.dataflow_id,
      key: input.key,
      observations: queryResult.observations.length,
    });

    // Canvas spill path
    const canvas = getCanvas();
    if (canvas) {
      const instance = await canvas.acquire(input.canvas_id, ctx);
      const rows = queryResult.observations.map((obs) => ({
        dataflow_id: input.dataflow_id,
        key: input.key,
        time_period: obs.time_period,
        value: obs.value,
        status: obs.status,
        unit: queryResult.seriesAttributes.unit,
        scale: queryResult.seriesAttributes.scale,
        decimals: queryResult.seriesAttributes.decimals,
      }));

      const result = await spillover({
        canvas: instance,
        source: (function* () {
          yield* rows;
        })(),
        previewChars: PREVIEW_CHARS,
        signal: ctx.signal,
      });

      if (result.spilled) {
        const obsFromPreview = result.previewRows as typeof rows;
        return {
          dataflow_id: input.dataflow_id,
          key: input.key,
          ...(input.start_period ? { start_period: input.start_period } : {}),
          ...(input.end_period ? { end_period: input.end_period } : {}),
          observations: obsFromPreview.map((r) => ({
            time_period: r.time_period as string,
            value: r.value as number | null,
            status: r.status as string | null,
          })),
          series_attributes: queryResult.seriesAttributes,
          observation_count: result.handle.rowCount,
          truncated: true,
          canvas_id: instance.canvasId,
          table_name: result.handle.tableName,
        };
      }
    }

    // Inline path (no canvas, or result fit in preview)
    return {
      dataflow_id: input.dataflow_id,
      key: input.key,
      ...(input.start_period ? { start_period: input.start_period } : {}),
      ...(input.end_period ? { end_period: input.end_period } : {}),
      observations: queryResult.observations,
      series_attributes: queryResult.seriesAttributes,
      observation_count: queryResult.observations.length,
      truncated: false,
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
    if (unit || scale) {
      const meta = [unit, scale, decimals != null ? `${decimals} decimals` : null]
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
      lines.push('\n| Time Period | Value | Status |');
      lines.push('|:------------|------:|:-------|');
      for (const obs of result.observations) {
        const val = obs.value != null ? obs.value.toString() : '—';
        const status = obs.status ?? '—';
        lines.push(`| ${obs.time_period} | ${val} | ${status} |`);
      }
    }

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
