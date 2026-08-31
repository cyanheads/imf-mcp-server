/**
 * @fileoverview Tool: imf_dataframe_query — run read-only SQL SELECT against a DataCanvas table.
 * @module mcp-server/tools/definitions/imf-dataframe-query.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { getCanvas } from '@/services/canvas/canvas-accessor.js';

/**
 * Cheap pre-canvas shape check, deliberately identical to the framework gate's own
 * `isSelectShaped` test. It exists so `invalid_sql` stays reachable when the canvas
 * is disabled (#2) — the authoritative statement-type check lives in the framework
 * and runs against DuckDB's parser, which types `WITH … SELECT` as SELECT and
 * `WITH … INSERT` as INSERT.
 */
const SELECT_SHAPED = /^\s*(?:SELECT|WITH)\b/i;
const RESPONSE_ENVELOPE_CHAR_LIMIT = 100_000;

type DataframeQueryResult = {
  rows: Array<Record<string, unknown>>;
  row_count: number;
  truncated: boolean;
};

function formatDataframeQueryResult(result: DataframeQueryResult) {
  const header = `**${result.row_count} row${result.row_count === 1 ? '' : 's'}**`;
  const truncationNote = result.truncated
    ? '\n\n_**Truncated** — capped by the response-size budget or canvas row limit, and more rows may match. Page the remainder with a stable ORDER BY plus LIMIT/OFFSET, or narrow the query._'
    : '';

  if (result.rows.length === 0) {
    return [{ type: 'text' as const, text: `${header}${truncationNote}` }];
  }

  const columns = Object.keys(result.rows[0] as object);
  const lines: string[] = [
    `${header}\n`,
    `| ${columns.join(' | ')} |`,
    `| ${columns.map(() => ':---').join(' | ')} |`,
  ];

  for (const row of result.rows) {
    const cells = columns.map((col) => {
      const value = row[col];
      return value == null ? '—' : String(value);
    });
    lines.push(`| ${cells.join(' | ')} |`);
  }

  return [{ type: 'text' as const, text: lines.join('\n') + truncationNote }];
}

function serializedSuccessEnvelopeLength(result: DataframeQueryResult): number {
  return JSON.stringify({
    structuredContent: result,
    content: formatDataframeQueryResult(result),
  }).length;
}

function fitResponseEnvelope(
  rows: Array<Record<string, unknown>>,
  canvasTruncated: boolean,
): DataframeQueryResult | undefined {
  const completeResult = { rows, row_count: rows.length, truncated: canvasTruncated };
  if (serializedSuccessEnvelopeLength(completeResult) <= RESPONSE_ENVELOPE_CHAR_LIMIT) {
    return completeResult;
  }

  let low = 0;
  let high = rows.length;
  while (low < high) {
    const midpoint = Math.ceil((low + high) / 2);
    const candidate = { rows: rows.slice(0, midpoint), row_count: midpoint, truncated: true };
    if (serializedSuccessEnvelopeLength(candidate) <= RESPONSE_ENVELOPE_CHAR_LIMIT) {
      low = midpoint;
    } else {
      high = midpoint - 1;
    }
  }

  if (low === 0 && rows.length > 0) return undefined;
  return { rows: rows.slice(0, low), row_count: low, truncated: true };
}

type ContractReason = 'canvas_not_found' | 'missing_table' | 'invalid_sql' | 'sql_not_permitted';

/**
 * DataCanvas-layer `data.reason` → this tool's declared contract reasons. The canvas
 * registry, the DuckDB provider, and the read-only SQL gate each throw with
 * framework-level reasons and recovery hints that name methods (`registerTable()`,
 * `describe()`) no MCP client can call, so every reason a `query()` can raise is
 * mapped back onto a reason this tool advertises. An unlisted reason is rethrown
 * untouched rather than mislabeled.
 */
const CANVAS_REASON_MAP: Record<string, ContractReason> = {
  canvas_not_found: 'canvas_not_found',
  missing_table: 'missing_table',
  // Statement shape and prepare failures — the same class the local check catches.
  invalid_sql: 'invalid_sql',
  non_select_statement: 'invalid_sql',
  multi_statement: 'invalid_sql',
  // Read-only gate denials: syntactically fine, but the operation is refused.
  denied_function: 'sql_not_permitted',
  denied_function_in_plan: 'sql_not_permitted',
  plan_operator_not_allowed: 'sql_not_permitted',
  system_catalog_access: 'sql_not_permitted',
};

export const imfDataframeQuery = tool('imf_dataframe_query', {
  description:
    'Run a read-only SQL SELECT against a DataCanvas table staged by imf_query_dataset. ' +
    'Supports multi-country comparisons, time-series aggregation, and cross-indicator joins. ' +
    'Requires imf_dataframe_describe first to discover table and column names. ' +
    'One SELECT statement per call; a leading WITH … SELECT (CTE) is accepted. DML and DDL are rejected.',
  annotations: {
    readOnlyHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  input: z.object({
    canvas_id: z
      .string()
      .describe(
        'Canvas ID returned by imf_query_dataset whenever staged=true. Call imf_dataframe_describe with it before writing SQL.',
      ),
    sql: z
      .string()
      .describe(
        'Read-only SQL SELECT statement — exactly one statement, starting with SELECT or with a WITH … SELECT common table expression. ' +
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
      .describe(
        'Largest result-row prefix whose complete structured and formatted response fits the 100,000-character response budget, after the canvas row limit (default 10,000) is applied.',
      ),
    row_count: z
      .number()
      .describe(
        'Number of materialized rows returned in rows. Always equals rows.length and never claims a pre-cap total.',
      ),
    truncated: z
      .boolean()
      .describe(
        'True when DataCanvas capped the query at its row limit or the server omitted materialized rows to fit the response-size budget. ' +
          'Page the remainder with a stable ORDER BY plus LIMIT/OFFSET, or narrow the query with WHERE or aggregation.',
      ),
  }),

  errors: [
    {
      reason: 'canvas_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'canvas_id does not match any registered DataCanvas session (expired, wrong session, or canvas disabled)',
      recovery: 'Re-run imf_query_dataset to obtain a fresh canvas_id.',
    },
    {
      reason: 'missing_table',
      code: JsonRpcErrorCode.NotFound,
      when: 'The canvas exists but sql references a table that is not staged on it — the table expired, was dropped, or the name is wrong',
      recovery:
        'Call imf_dataframe_describe with this canvas_id to list the tables currently staged, or re-run imf_query_dataset to stage the source data again.',
    },
    {
      reason: 'invalid_sql',
      code: JsonRpcErrorCode.ValidationError,
      when: 'sql is not a single SELECT statement (a leading WITH … SELECT counts as one), or it is SELECT-shaped but fails to prepare — unknown column, unknown function, or a syntax error',
      recovery:
        'Send exactly one SELECT (or WITH … SELECT) statement and check every column and table name against imf_dataframe_describe.',
    },
    {
      reason: 'sql_not_permitted',
      code: JsonRpcErrorCode.ValidationError,
      when: 'sql parses as a SELECT but the read-only gate refuses it — it calls an external-data or PRAGMA table function, reads a system catalog, or plans an operator outside the read-only allowlist',
      recovery:
        'Query only the tables listed by imf_dataframe_describe using plain SELECT features; file-reading functions and catalog introspection are not available here.',
    },
    {
      reason: 'response_too_large',
      code: JsonRpcErrorCode.SerializationError,
      when: 'The first result row cannot fit in the complete structured and formatted response budget',
      recovery:
        'Select fewer columns, aggregate the result, or return shorter values so one complete row fits the response budget.',
    },
  ],

  async handler(input, ctx) {
    // Validate SQL shape before canvas acquisition — invalid_sql is a client error
    // independent of whether the canvas is enabled (#2).
    if (!SELECT_SHAPED.test(input.sql)) {
      throw ctx.fail(
        'invalid_sql',
        'SQL must be a SELECT statement, optionally opening with a WITH … SELECT common table expression. DML and DDL are not permitted.',
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

    let result: Awaited<ReturnType<typeof instance.query>>;
    try {
      result = await instance.query(input.sql, {
        signal: ctx.signal,
        denySystemCatalogs: true,
      });
    } catch (err: unknown) {
      if (!(err instanceof McpError)) throw err;
      const reason = err.data?.reason;
      const mapped = typeof reason === 'string' ? CANVAS_REASON_MAP[reason] : undefined;
      if (!mapped) throw err;

      if (mapped === 'missing_table') {
        // The framework's own hint names registerTable()/describe(), neither of
        // which is reachable over MCP — restate it in terms of this server's tools.
        const tableName = err.data?.tableName;
        throw ctx.fail(
          'missing_table',
          `Canvas table ${typeof tableName === 'string' ? `'${tableName}'` : 'referenced by the query'} is not staged on canvas '${input.canvas_id}'.`,
          {
            canvasId: input.canvas_id,
            ...(typeof tableName === 'string' ? { tableName } : {}),
            ...ctx.recoveryFor('missing_table'),
          },
        );
      }

      // The layer's own message names the offending statement type, function, or
      // operator and is already sanitized upstream — keep it, add a usable hint.
      throw ctx.fail(mapped, err.message, {
        canvasId: input.canvas_id,
        ...ctx.recoveryFor(mapped),
      });
    }

    const response = fitResponseEnvelope(result.rows, result.truncated === true);
    if (!response) {
      throw ctx.fail(
        'response_too_large',
        'The first query row exceeds the 100,000-character response budget.',
        ctx.recoveryFor('response_too_large'),
      );
    }
    ctx.log.info('Canvas query executed', {
      canvasId: input.canvas_id,
      rowCount: response.row_count,
      truncated: response.truncated,
    });

    return response;
  },

  format: formatDataframeQueryResult,
});
