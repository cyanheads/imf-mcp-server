/**
 * @fileoverview Tool: imf_dataframe_describe — list DataCanvas tables and columns.
 * @module mcp-server/tools/definitions/imf-dataframe-describe.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getCanvas } from '@/services/canvas/canvas-accessor.js';

export const imfDataframeDescribe = tool('imf_dataframe_describe', {
  description:
    'List DataCanvas tables and columns staged by a prior imf_query_dataset call. ' +
    "Returns each table's name, row count, and column schema (name + DuckDB type). " +
    'Required before imf_dataframe_query to discover the table and column names for SQL.',
  annotations: {
    readOnlyHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  input: z.object({
    canvas_id: z
      .string()
      .describe(
        'Canvas ID returned by imf_query_dataset when results were too large for inline delivery.',
      ),
  }),
  output: z.object({
    canvas_id: z.string().describe('Canvas session ID that was introspected.'),
    tables: z
      .array(
        z
          .object({
            name: z.string().describe('Table name — use this in imf_dataframe_query SQL.'),
            row_count: z.number().describe('Number of rows in this table.'),
            columns: z
              .array(
                z
                  .object({
                    name: z
                      .string()
                      .describe('Column name — use this in SELECT and WHERE clauses.'),
                    type: z.string().describe('DuckDB column type, e.g. VARCHAR, DOUBLE, BIGINT.'),
                  })
                  .describe('A single column definition.'),
              )
              .describe('Column schema for this table.'),
          })
          .describe('A single canvas table with its schema.'),
      )
      .describe('All tables registered on this canvas.'),
    table_count: z.number().describe('Total number of tables on the canvas.'),
  }),

  errors: [
    {
      reason: 'canvas_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'canvas_id does not match any registered DataCanvas table (expired, wrong session, or canvas disabled)',
      recovery:
        'Re-run imf_query_dataset to obtain a fresh canvas_id; ensure CANVAS_PROVIDER_TYPE=duckdb is set.',
    },
  ],

  async handler(input, ctx) {
    const canvas = getCanvas();
    if (!canvas) {
      throw ctx.fail(
        'canvas_not_found',
        'DataCanvas is not enabled. Set CANVAS_PROVIDER_TYPE=duckdb.',
        ctx.recoveryFor('canvas_not_found'),
      );
    }

    let instance: Awaited<ReturnType<typeof canvas.acquire>>;
    try {
      instance = await canvas.acquire(input.canvas_id, ctx);
    } catch {
      throw ctx.fail('canvas_not_found', `Canvas '${input.canvas_id}' not found or expired`, {
        canvasId: input.canvas_id,
        ...ctx.recoveryFor('canvas_not_found'),
      });
    }

    const tableInfos = await instance.describe();
    ctx.log.info('Canvas described', { canvasId: input.canvas_id, tables: tableInfos.length });

    return {
      canvas_id: instance.canvasId,
      tables: tableInfos.map((t) => ({
        name: t.name,
        row_count: t.rowCount,
        columns: t.columns.map((c) => ({ name: c.name, type: c.type })),
      })),
      table_count: tableInfos.length,
    };
  },

  format: (result) => {
    const lines: string[] = [
      `**Canvas:** \`${result.canvas_id}\``,
      `**Tables:** ${result.table_count}\n`,
    ];

    for (const t of result.tables) {
      lines.push(`### ${t.name} (${t.row_count} rows)`);
      lines.push('| Column | Type |');
      lines.push('|:-------|:-----|');
      for (const col of t.columns) {
        lines.push(`| ${col.name} | ${col.type} |`);
      }
      lines.push('');
    }

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
