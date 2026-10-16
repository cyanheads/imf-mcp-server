/**
 * @fileoverview Tool: imf_dataframe_query — run read-only SQL SELECT against a DataCanvas table.
 * @module mcp-server/tools/definitions/imf-dataframe-query.tool
 */

import { disabledTool, tool, z } from '@cyanheads/mcp-ts-core';
import { CanvasIdSchema } from '@cyanheads/mcp-ts-core/canvas';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { isCanvasConfigured } from '@/config/server-config.js';
import { clipTableCell, lineBreaksAsSpaces, tableCell } from '@/mcp-server/markdown-table.js';
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

/**
 * A result value as cell text before escaping. A STRUCT, LIST, or MAP — which only
 * caller SQL produces — arrives as a plain object or array (DuckDB's JSON row
 * reader turns BIGINT into a decimal string at every depth), so it renders as the
 * compact JSON `structuredContent.rows` carries for it.
 */
function cellText(value: unknown): string | null {
  if (value == null) return null;
  return typeof value === 'object' ? JSON.stringify(value) : String(value);
}

type ContentBlocks = Array<{ type: 'text'; text: string }>;

/** `text` as a table cell, clipped to `cellCap` (marker included) when that shortens it; null when it stays whole. */
function clippedCell(text: string, cellCap: number | undefined): string | null {
  if (cellCap === undefined) return null;
  const whole = tableCell(text).length;
  if (whole <= cellCap) return null;
  const clipped = clipTableCell(text, cellCap);
  return clipped.length < whole ? clipped : null;
}

/** `column 2`, or `columns 1, 2 and 4` — 1-based positions. */
function columnPositions(indexes: number[]): string {
  const positions = indexes.map((index) => String(index + 1));
  const last = positions.pop();
  return positions.length === 0 ? `column ${last}` : `columns ${positions.join(', ')} and ${last}`;
}

const TRUNCATION_NOTE =
  '\n\n_**Truncated** — capped by the response-size budget or canvas row limit, and more rows may match. Page the remainder with a stable ORDER BY plus LIMIT/OFFSET, or narrow the query._';

const rowCountHeader = (result: DataframeQueryResult) =>
  `**${result.row_count} row${result.row_count === 1 ? '' : 's'}**`;

/**
 * The markdown table for `result`. With `cellCap`, a header label or cell
 * rendering longer than the cap is clipped to it (marker included) wherever that
 * shortens it, and a line under the table says what was clipped. A column whose
 * name was clipped is named there by its position, never by its full name.
 */
function renderContent(result: DataframeQueryResult, cellCap?: number): ContentBlocks {
  const header = rowCountHeader(result);
  const truncationNote = result.truncated ? TRUNCATION_NOTE : '';

  if (result.rows.length === 0) {
    return [{ type: 'text', text: `${header}${truncationNote}` }];
  }

  const columns = Object.keys(result.rows[0] as object);
  const clippedNames: number[] = [];
  const labels = columns.map((col, index) => {
    const clipped = clippedCell(col, cellCap);
    if (clipped === null) return tableCell(col);
    clippedNames.push(index);
    return clipped;
  });
  const lines: string[] = [
    `${header}\n`,
    `| ${labels.join(' | ')} |`,
    `| ${columns.map(() => ':---').join(' | ')} |`,
  ];

  const clippedValues = new Set<number>();
  for (const row of result.rows) {
    const cells = columns.map((col, index) => {
      const text = cellText(row[col]);
      const clipped = text == null ? null : clippedCell(text, cellCap);
      if (clipped === null) return tableCell(text);
      clippedValues.add(index);
      return clipped;
    });
    lines.push(`| ${cells.join(' | ')} |`);
  }

  const one = clippedNames.length === 1;
  const names = `long name${one ? '' : 's'} of ${columnPositions(clippedNames)} ${one ? 'is' : 'are'} cut short in the header row`;
  const fullNames = "each column's full name is its key in structuredContent.rows.";
  let clipNote = '';
  if (clippedValues.size > 0) {
    const valueColumns = [...clippedValues]
      .map((index) =>
        clippedNames.includes(index)
          ? `column ${index + 1}`
          : `"${tableCell(columns[index] ?? '')}"`,
      )
      .join(', ');
    clipNote = `long values in ${valueColumns} are cut short in this table to fit the response budget; structuredContent.rows carries every value whole. Read the rest with SUBSTR(column, start, length) in a follow-up query.${clippedNames.length > 0 ? ` The ${names}; ${fullNames}` : ''}`;
  } else if (clippedNames.length > 0) {
    clipNote = `the ${names} to fit the response budget; ${fullNames}`;
  }

  return [
    {
      type: 'text',
      text: lines.join('\n') + (clipNote ? `\n\n_**Clipped** — ${clipNote}_` : '') + truncationNote,
    },
  ];
}

/**
 * A value as the unescaped table of earlier releases showed it: `String(value)`,
 * so a LIST is its items joined by commas and a STRUCT is `[object Object]` (a MAP,
 * which arrives as a list of key/value entries, shows one `[object Object]` per entry).
 */
function flattenedText(value: unknown): string | null {
  return value == null ? null : String(value);
}

const FLATTENED_NOTE =
  '\n\n_**Flattened** — nested values are shown as plain text in this list to fit the response budget; structuredContent.rows carries their structure._';

/**
 * The single row of `result` as a fenced code block of one `name: value` line
 * per column, for a row too wide for a table even clipped. Inside a fence
 * nothing is escaped, so names and values are raw, with a line break as a space
 * (as `tableCell` renders one) and null as `—`. A nested value is its compact
 * JSON, or with `flatten` its `flattenedText`, and a line under the block says
 * so. The fence is always three backticks: under CommonMark only a line holding
 * nothing but backticks and spaces closes it, and every line here holds `: `.
 */
function renderRowBlock(result: DataframeQueryResult, flatten = false): ContentBlocks {
  const row = result.rows[0] as Record<string, unknown>;
  const valueText = flatten ? flattenedText : cellText;
  const body = Object.entries(row)
    .map(
      ([col, value]) =>
        `${lineBreaksAsSpaces(col)}: ${lineBreaksAsSpaces(valueText(value) ?? '—')}`,
    )
    .join('\n');
  return [
    {
      type: 'text',
      text:
        `${rowCountHeader(result)}\n\n` +
        '_This row has too many columns for a table within the response budget, so each column is listed below as one `name: value` line; structuredContent.rows carries the same row._' +
        `\n\n\`\`\`\n${body}\n\`\`\`${flatten ? FLATTENED_NOTE : ''}${result.truncated ? TRUNCATION_NOTE : ''}`,
    },
  ];
}

/**
 * The single row of `result` as nothing but the row count and a pointer to
 * `structuredContent.rows`, for a row no rendering of which fits the response
 * budget. Before any truncation note it serializes to 75 characters, no more than
 * the cheapest table earlier releases rendered for a row that can need it: such a
 * row holds a value whose JSON fills most of the budget, every such value showed at
 * least `[object Object]` there, and one such cell costs 75 even under an empty
 * column name, which DuckDB rejects anyway.
 */
function renderPointer(result: DataframeQueryResult): ContentBlocks {
  return [
    {
      type: 'text',
      text: `${rowCountHeader(result)}\n\nToo big; see structuredContent.rows${result.truncated ? TRUNCATION_NOTE : ''}`,
    },
  ];
}

/** `JSON.stringify({ structuredContent, content })` around its two serialized parts. */
const ENVELOPE_KEYS_LENGTH = '{"structuredContent":,"content":}'.length;

/**
 * The formatted table, fitted to the response budget when the result is a single
 * row. Rows are dropped before any cell is clipped, so clipping applies only once
 * one row is all that is left. The cap is the largest per-cell length at which
 * the row fits, header labels included: cells and labels shorter than it stay
 * whole, and the budget left after `structuredContent` is shared evenly among the
 * long ones. A row that does not fit as a table even with every long cell and
 * label clipped to its marker — escaping costs a short `|`, backslash, or
 * backtick cell more than the marker saves — is listed as a fenced
 * `name: value` block instead, under a fixed three-backtick fence. Nested values
 * stay JSON in the block when it fits that way; otherwise they are flattened to
 * the `String(value)` text earlier releases' table showed, with a line saying
 * so. Per column the block then costs the name, that same value text, and four
 * serialized characters (`: ` and an escaped newline), against the 13 an
 * unescaped table spent on the same column (` | ` on three lines and `:---`),
 * so no column costs more listed than it did in that table. A row that does not
 * fit even listed — a few nested columns whose JSON alone nearly fills the
 * budget, which that table showed as `[object Object]` — gets `renderPointer`
 * instead, and the handler refuses as `response_too_large` only a row whose
 * `structuredContent` with that pointer still exceeds the budget.
 */
function formatDataframeQueryResult(result: DataframeQueryResult): ContentBlocks {
  const content = renderContent(result);
  if (result.rows.length !== 1) return content;

  // A BigInt, which DuckDB's row reader never yields but a direct format() caller
  // can pass, is measured as the decimal text its cell shows.
  const structuredLength = JSON.stringify(result, (_key, value) =>
    typeof value === 'bigint' ? String(value) : value,
  ).length;
  const fits = (blocks: ContentBlocks) =>
    ENVELOPE_KEYS_LENGTH + structuredLength + JSON.stringify(blocks).length <=
    RESPONSE_ENVELOPE_CHAR_LIMIT;
  if (fits(content)) return content;
  const row = result.rows[0] as Record<string, unknown>;
  if (!fits(renderContent(result, 0))) {
    const listings = [renderRowBlock(result)];
    if (Object.values(row).some((value) => typeof value === 'object' && value !== null)) {
      listings.push(renderRowBlock(result, true));
    }
    return listings.find(fits) ?? renderPointer(result);
  }

  let low = 0;
  let high = Math.max(
    ...Object.keys(row).map((col) => tableCell(col).length),
    ...Object.values(row).map((value) => tableCell(cellText(value)).length),
  );
  while (low < high) {
    const midpoint = Math.ceil((low + high) / 2);
    if (fits(renderContent(result, midpoint))) {
      low = midpoint;
    } else {
      high = midpoint - 1;
    }
  }
  return renderContent(result, low);
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

type ContractReason =
  | 'canvas_not_found'
  | 'missing_table'
  | 'invalid_sql'
  | 'sql_not_permitted'
  | 'sql_execution_error';

/**
 * DataCanvas-layer `data.reason` → this tool's declared contract reasons. The canvas
 * registry, the DuckDB provider, and the read-only SQL gate each throw with
 * framework-level reasons and recovery hints that name methods (`registerTable()`,
 * `describe()`) no MCP client can call, so every reason a `query()` can raise is
 * mapped back onto a reason this tool advertises. An unlisted reason is rethrown
 * untouched rather than mislabeled. `sql_parse_error` is not listed: SELECT-shaped
 * SQL that fails to parse surfaces as the gate's `invalid_sql` prepare failure.
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
  // The engine's refusal of a file named in the SQL.
  sql_read_only: 'sql_not_permitted',
  // Prepared cleanly, then failed on the staged data (a cast, an overflow).
  sql_execution_error: 'sql_execution_error',
};

const imfDataframeQueryDefinition = tool('imf_dataframe_query', {
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
    canvas_id: CanvasIdSchema.describe(
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
            'A result row — keys are the selected column names; values are the JSON form of each DuckDB type: number, string (BIGINT, DECIMAL, and dates included), boolean, null, or an object/array for STRUCT, LIST, and MAP.',
          ),
      )
      .describe(
        'Largest result-row prefix whose complete structured and formatted response fits the 100,000-character response budget, after the canvas row limit (default 10,000) is applied. ' +
          'Values and column names are always whole here; when a single row only fits with its long cells or column names clipped in the formatted table, listed there one name: value line per column, or replaced there by a one-line pointer to this field, it is returned alone.',
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
      severity: 'warning',
      recovery: 'Re-run imf_query_dataset to obtain a fresh canvas_id.',
    },
    {
      reason: 'missing_table',
      code: JsonRpcErrorCode.NotFound,
      when: 'The canvas exists but sql references a table that is not staged on it — the table expired, was dropped, or the name is wrong',
      severity: 'warning',
      recovery:
        'Call imf_dataframe_describe with this canvas_id to list the tables currently staged, or re-run imf_query_dataset to stage the source data again.',
    },
    {
      reason: 'invalid_sql',
      code: JsonRpcErrorCode.ValidationError,
      when: 'sql is not a single SELECT statement (a leading WITH … SELECT counts as one), or it is SELECT-shaped but fails to prepare — unknown column, unknown function, or a syntax error',
      severity: 'warning',
      recovery:
        'Send exactly one SELECT (or WITH … SELECT) statement and check every column and table name against imf_dataframe_describe.',
    },
    {
      reason: 'sql_not_permitted',
      code: JsonRpcErrorCode.ValidationError,
      when: 'sql parses as a SELECT but the read-only gate refuses it — it calls an external-data or PRAGMA table function, reads a system catalog, plans an operator outside the read-only allowlist, or names a file instead of a staged table',
      severity: 'warning',
      recovery:
        'Query only the tables listed by imf_dataframe_describe using plain SELECT features; file-reading functions and catalog introspection are not available here.',
    },
    {
      reason: 'sql_execution_error',
      code: JsonRpcErrorCode.ValidationError,
      when: 'sql prepares but fails while it runs, such as a failed cast or an arithmetic overflow',
      severity: 'warning',
      recovery:
        'Use TRY_CAST for a conversion that can fail, cast to a wider type such as HUGEINT or DOUBLE before arithmetic that can overflow, or filter out the rows the message names.',
    },
    {
      reason: 'response_too_large',
      code: JsonRpcErrorCode.SerializationError,
      when: 'The first result row alone exceeds the response budget as structured content, even with the formatted text reduced to a one-line pointer to it',
      recovery:
        'Select fewer columns, aggregate the result, or return shorter values and column aliases so one complete row fits the response budget.',
    },
  ],

  async handler(input, ctx) {
    // Validate SQL shape before canvas acquisition — invalid_sql is a client error
    // independent of whether the canvas is enabled (#2).
    if (!SELECT_SHAPED.test(input.sql)) {
      throw ctx.fail(
        'invalid_sql',
        'SQL must be a SELECT statement, optionally opening with a WITH … SELECT common table expression. DML and DDL are not permitted.',
      );
    }

    const canvas = getCanvas();
    if (!canvas) {
      throw ctx.fail(
        'canvas_not_found',
        'DataCanvas is not enabled. Set CANVAS_PROVIDER_TYPE=duckdb.',
      );
    }

    let instance: Awaited<ReturnType<typeof canvas.acquire>>;
    try {
      instance = await canvas.acquire(input.canvas_id, ctx);
    } catch {
      throw ctx.fail('canvas_not_found', `Canvas '${input.canvas_id}' not found or expired`, {
        canvasId: input.canvas_id,
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
          },
        );
      }

      // The layer's own message names the offending statement type, function, or
      // operator and is already sanitized upstream — keep it; the framework adds
      // this tool's declared hint for the mapped reason.
      throw ctx.fail(mapped, err.message, { canvasId: input.canvas_id });
    }

    const response = fitResponseEnvelope(result.rows, result.truncated === true);
    if (!response) {
      throw ctx.fail(
        'response_too_large',
        'The first query row exceeds the 100,000-character response budget as structured content alone, even with the text output reduced to a one-line pointer to it.',
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

/** Nothing is ever staged without a canvas, so the tool is listed only with one. */
export const imfDataframeQuery = isCanvasConfigured()
  ? imfDataframeQueryDefinition
  : disabledTool(imfDataframeQueryDefinition, {
      reason: 'DataCanvas is not configured in this deployment.',
      hint: 'CANVAS_PROVIDER_TYPE=duckdb',
    });
