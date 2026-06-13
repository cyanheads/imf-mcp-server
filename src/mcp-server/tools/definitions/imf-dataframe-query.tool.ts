/**
 * @fileoverview Tool: imf_dataframe_query — run read-only SQL SELECT against a DataCanvas table.
 * @module mcp-server/tools/definitions/imf-dataframe-query.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getCanvas } from '@/services/canvas/canvas-accessor.js';

export const imfDataframeQuery = tool('imf_dataframe_query', {
  description:
    'Run a read-only SQL SELECT against a DataCanvas table staged by imf_query_dataset. ' +
    'Supports multi-country comparisons, time-series aggregation, and cross-indicator joins. ' +
    'Requires imf_dataframe_describe first to discover table and column names. ' +
    'Only SELECT statements are accepted — DML and DDL are rejected.',
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
    sql: z
      .string()
      .describe(
        'Read-only SQL SELECT statement. Must start with SELECT. ' +
          'Reference tables by the names returned by imf_dataframe_describe. ' +
          "Example: SELECT time_period, value FROM spilled_abc123 WHERE time_period >= '2010' ORDER BY time_period.",
      ),
  }),
  output: z.object({
    rows: z
      .array(
        z
          .record(z.string(), z.unknown())
          .describe(
            'A result row — keys are the selected column names, values match the column DuckDB types (string, number, null).',
          ),
      )
      .describe('Query result rows, capped at the canvas row limit (default 10,000).'),
    row_count: z.number().describe('Total matching rows before the cap — may exceed rows.length.'),
  }),

  errors: [
    {
      reason: 'canvas_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'canvas_id does not match any registered DataCanvas table (expired, wrong session, or canvas disabled)',
      recovery: 'Re-run imf_query_dataset to obtain a fresh canvas_id.',
    },
    {
      reason: 'invalid_sql',
      code: JsonRpcErrorCode.ValidationError,
      when: 'sql does not start with SELECT — DML and DDL statements are not permitted',
      recovery:
        'Rewrite the statement as a SELECT query referencing tables from imf_dataframe_describe.',
    },
  ],

  async handler(input, ctx) {
    // Validate SQL before canvas acquisition — invalid_sql is a client error
    // independent of whether the canvas is enabled.
    if (!/^\s*SELECT\s/i.test(input.sql)) {
      throw ctx.fail(
        'invalid_sql',
        'SQL must be a SELECT statement. DML and DDL are not permitted.',
        ctx.recoveryFor('invalid_sql'),
      );
    }

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

    const result = await instance.query(input.sql, {
      signal: ctx.signal,
      denySystemCatalogs: true,
    });
    ctx.log.info('Canvas query executed', {
      canvasId: input.canvas_id,
      rowCount: result.rowCount,
    });

    return { rows: result.rows, row_count: result.rowCount };
  },

  format: (result) => {
    if (result.rows.length === 0) {
      return [{ type: 'text', text: `**0 rows** (${result.row_count} total)` }];
    }

    const columns = Object.keys(result.rows[0] as object);
    const lines: string[] = [
      `**${result.row_count} row${result.row_count === 1 ? '' : 's'}**\n`,
      `| ${columns.join(' | ')} |`,
      `| ${columns.map(() => ':---').join(' | ')} |`,
    ];

    for (const row of result.rows) {
      const cells = columns.map((col) => {
        const v = (row as Record<string, unknown>)[col];
        return v == null ? '—' : String(v);
      });
      lines.push(`| ${cells.join(' | ')} |`);
    }

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
