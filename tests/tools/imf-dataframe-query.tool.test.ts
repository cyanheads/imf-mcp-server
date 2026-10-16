/**
 * @fileoverview Tests for the imf_dataframe_query tool.
 * @module tests/tools/imf-dataframe-query.tool.test
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CanvasRegistry, DataCanvas, DuckdbProvider } from '@cyanheads/mcp-ts-core/canvas';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { captureMcpError, contractError } from '../helpers/errors.js';
import { fencedCodeBlock, rowCells } from '../helpers/markdown-table.js';

vi.mock('@/services/canvas/canvas-accessor.js', () => ({
  getCanvas: vi.fn(),
}));

import { imfDataframeQuery } from '@/mcp-server/tools/definitions/imf-dataframe-query.tool.js';
import { getCanvas } from '@/services/canvas/canvas-accessor.js';

const MOCK_ROWS = [
  { time_period: '2020', value: 3.5, status: null },
  { time_period: '2021', value: 5.1, status: 'E' },
];

/**
 * A canvas id the registry does not hold, in the shape `CanvasIdSchema`
 * advertises — 10 characters from `[A-Za-z0-9_-]`. It has to be well-formed:
 * a malformed id is rejected at argument validation and never reaches the
 * handler, so a badly-shaped literal here would test the schema, not the miss.
 */
const EXPIRED_CANVAS_ID = 'cv0expired';

const RESPONSE_ENVELOPE_CHAR_LIMIT = 100_000;

function serializedSuccessEnvelopeLength(result: {
  rows: Array<Record<string, unknown>>;
  row_count: number;
  truncated: boolean;
}): number {
  return JSON.stringify({
    structuredContent: result,
    content: imfDataframeQuery.format!(result),
  }).length;
}

/** One row of `count` columns `c0`, `c1`, … each holding `value`. */
const wideRow = (count: number, value: unknown): Record<string, unknown> =>
  Object.fromEntries(Array.from({ length: count }, (_, i) => [`c${i}`, value]));

/**
 * The success envelope 0.4.3 emitted for a one-row result: an unescaped table
 * with every name and value raw (`String(value)`, `—` for null).
 */
function previousReleaseEnvelopeLength(row: Record<string, unknown>): number {
  const columns = Object.keys(row);
  const text = [
    '**1 row**\n',
    `| ${columns.join(' | ')} |`,
    `| ${columns.map(() => ':---').join(' | ')} |`,
    `| ${columns.map((col) => (row[col] == null ? '—' : String(row[col]))).join(' | ')} |`,
  ].join('\n');
  return JSON.stringify({
    structuredContent: { rows: [row], row_count: 1, truncated: false },
    content: [{ type: 'text', text }],
  }).length;
}

/**
 * The fenced block a one-row result too wide for a table renders as, parsed by
 * the CommonMark fence rules: the fence and the `name: value` lines before the
 * first line a renderer would read as its closing fence.
 */
function rowBlock(text: string): { fence: string; lines: string[] } {
  const { fence, lines, closed } = fencedCodeBlock(text);
  expect(closed).toBe(true);
  return { fence, lines };
}

const ROW_BLOCK_NOTE =
  '_This row has too many columns for a table within the response budget, so each column is listed below as one `name: value` line; structuredContent.rows carries the same row._';

const FLATTENED_NOTE =
  '_**Flattened** — nested values are shown as plain text in this list to fit the response budget; structuredContent.rows carries their structure._';

/** The whole `content[]` text of a one-row result too large for any rendering of the row. */
const POINTER_TEXT = '**1 row**\n\nToo big; see structuredContent.rows';

/** A STRUCT holding one `length`-character string. */
const bigStruct = (length: number) => ({ a: 'x'.repeat(length) });

/** The longest `bigStruct` string 0.4.3 served in each of `count` columns of one row. */
function previousReleaseStructBoundary(count: number): number {
  let low = 0;
  let high = RESPONSE_ENVELOPE_CHAR_LIMIT;
  while (low < high) {
    const midpoint = Math.ceil((low + high) / 2);
    if (
      previousReleaseEnvelopeLength(wideRow(count, bigStruct(midpoint))) <=
      RESPONSE_ENVELOPE_CHAR_LIMIT
    ) {
      low = midpoint;
    } else {
      high = midpoint - 1;
    }
  }
  return low;
}

/** A value as 0.4.3 rendered it in a cell: `String(value)`, `—` for null. */
const previousReleaseText = (value: unknown) => (value == null ? '—' : String(value));

/** Strip the GFM backslash escapes from one rendered cell. */
const unescapeCell = (cell: string) => cell.replace(/\\(.)/g, '$1');

/** The markdown table lines (header, separator, rows) of a formatted result. */
function tableLines(result: {
  rows: Array<Record<string, unknown>>;
  row_count: number;
  truncated: boolean;
}): string[] {
  const text = (imfDataframeQuery.format!(result)[0] as { text: string }).text;
  return text.split('\n').filter((line) => line.startsWith('|'));
}

/** Wire a canvas whose `query()` resolves or rejects with the supplied outcome. */
function mockCanvasQuery(outcome: { resolve: unknown } | { reject: unknown }) {
  const query =
    'resolve' in outcome
      ? vi.fn().mockResolvedValue(outcome.resolve)
      : vi.fn().mockRejectedValue(outcome.reject);
  (getCanvas as ReturnType<typeof vi.fn>).mockReturnValue({
    acquire: vi.fn().mockResolvedValue({ canvasId: 'canvas-abc', query }),
  });
  return query;
}

describe('imfDataframeQuery', () => {
  beforeEach(() => {
    (getCanvas as ReturnType<typeof vi.fn>).mockReturnValue(undefined);
  });

  it('throws ctx.fail("canvas_not_found") when canvas is disabled', async () => {
    const ctx = createMockContext({ tenantId: 'test', errors: imfDataframeQuery.errors });
    const input = imfDataframeQuery.input.parse({
      canvas_id: 'canvas-abc',
      sql: 'SELECT * FROM spilled_abc123',
    });

    await expect(imfDataframeQuery.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'canvas_not_found' },
    });
  });

  it('throws ctx.fail("invalid_sql") for DML even when canvas is disabled', async () => {
    // Canvas is not enabled — SQL validation must fire before the canvas check.
    const ctx = createMockContext({ tenantId: 'test', errors: imfDataframeQuery.errors });
    const input = imfDataframeQuery.input.parse({
      canvas_id: 'canvas-abc',
      sql: 'DROP TABLE spilled_abc123',
    });

    await expect(imfDataframeQuery.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'invalid_sql' },
    });
  });

  it('throws ctx.fail("invalid_sql") for INSERT even when canvas is disabled', async () => {
    const ctx = createMockContext({ tenantId: 'test', errors: imfDataframeQuery.errors });
    const input = imfDataframeQuery.input.parse({
      canvas_id: 'canvas-abc',
      sql: 'INSERT INTO foo VALUES (1)',
    });

    await expect(imfDataframeQuery.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'invalid_sql' },
    });
  });

  it('throws ctx.fail("canvas_not_found") when canvas.acquire fails', async () => {
    (getCanvas as ReturnType<typeof vi.fn>).mockReturnValue({
      acquire: vi.fn().mockRejectedValue(new Error('expired')),
    });
    const ctx = createMockContext({ tenantId: 'test', errors: imfDataframeQuery.errors });
    const input = imfDataframeQuery.input.parse({
      canvas_id: EXPIRED_CANVAS_ID,
      sql: 'SELECT * FROM spilled_abc123',
    });

    await expect(imfDataframeQuery.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'canvas_not_found' },
    });
  });

  it('executes SELECT and returns rows', async () => {
    const mockInstance = {
      canvasId: 'canvas-abc',
      query: vi.fn().mockResolvedValue({ rows: MOCK_ROWS, rowCount: 2 }),
    };
    (getCanvas as ReturnType<typeof vi.fn>).mockReturnValue({
      acquire: vi.fn().mockResolvedValue(mockInstance),
    });

    const ctx = createMockContext({ tenantId: 'test', errors: imfDataframeQuery.errors });
    const input = imfDataframeQuery.input.parse({
      canvas_id: 'canvas-abc',
      sql: 'SELECT time_period, value FROM spilled_abc123 ORDER BY time_period',
    });
    const result = await imfDataframeQuery.handler(input, ctx);

    expect(result.row_count).toBe(2);
    expect(result.rows).toHaveLength(2);
    expect(result.rows[0]).toEqual({ time_period: '2020', value: 3.5, status: null });
  });

  it('accepts SELECT with leading whitespace', async () => {
    const mockInstance = {
      canvasId: 'canvas-abc',
      query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
    };
    (getCanvas as ReturnType<typeof vi.fn>).mockReturnValue({
      acquire: vi.fn().mockResolvedValue(mockInstance),
    });

    const ctx = createMockContext({ tenantId: 'test', errors: imfDataframeQuery.errors });
    const input = imfDataframeQuery.input.parse({
      canvas_id: 'canvas-abc',
      sql: '  SELECT count(*) FROM spilled_abc123',
    });

    await expect(imfDataframeQuery.handler(input, ctx)).resolves.toBeDefined();
  });

  it('formats rows as markdown table', () => {
    const output = {
      rows: MOCK_ROWS as Array<Record<string, unknown>>,
      row_count: 2,
      truncated: false,
    };
    const blocks = imfDataframeQuery.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('2020');
    expect(text).toContain('3.5');
    expect(text).toContain('time_period');
    expect(text).toContain('value');
  });

  it('formats empty result set', () => {
    const output = { rows: [], row_count: 0, truncated: false };
    const blocks = imfDataframeQuery.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('0');
  });

  it('renders plain strings, numbers, and null cells unchanged', () => {
    expect(tableLines({ rows: MOCK_ROWS, row_count: 2, truncated: false })).toEqual([
      '| time_period | value | status |',
      '| :--- | :--- | :--- |',
      '| 2020 | 3.5 | — |',
      '| 2021 | 5.1 | E |',
    ]);
  });

  // -------------------------------------------------------------------------
  // #59: header and cell text is escaped so every row keeps its columns
  // -------------------------------------------------------------------------

  it('#59 escapes cell text that would split, restyle, or break its row', () => {
    const texts = ['a|b', 'a`b', 'end\\', 'p\\|q', 'x\ny', 'x\r\ny', 'x\ry'];
    const rows = texts.map((s, i) => ({ s, n: i }));
    const lines = tableLines({ rows, row_count: rows.length, truncated: false });

    expect(lines.slice(2).map((line) => rowCells(line)[0])).toEqual([
      'a\\|b',
      'a\\`b',
      'end\\\\',
      'p\\\\\\|q',
      'x y',
      'x y',
      'x y',
    ]);
    lines.slice(2).forEach((line, i) => {
      const cells = rowCells(line);
      // An unescaped | adds a cell; the row keeps exactly its two.
      expect.soft(cells).toHaveLength(2);
      // Unescaping gives back the text as queried, line breaks aside.
      expect.soft(unescapeCell(cells[0]!)).toBe(texts[i]!.replace(/\r\n|\r|\n/g, ' '));
    });
  });

  it('#59 escapes a column alias carrying | or a backtick and leaves the separator row alone', () => {
    const rows = [{ 'c|d': 1, 'a`b': 'x', plain: 2 }];
    const [header, separator, row] = tableLines({ rows, row_count: 1, truncated: false });

    expect(header).toBe('| c\\|d | a\\`b | plain |');
    expect(rowCells(header!).map(unescapeCell)).toEqual(['c|d', 'a`b', 'plain']);
    expect(separator).toBe('| :--- | :--- | :--- |');
    expect(row).toBe('| 1 | x | 2 |');
  });

  it('#59 renders STRUCT and LIST cells as their escaped compact JSON', () => {
    // The shapes DuckDB's JSON row reader hands the tool: objects, arrays, and
    // BIGINT as a decimal string, nested or not.
    const rows = [
      {
        st: { a: 1, b: 'x|y' },
        l: [1, 2],
        nested: [{ k: '9223372036854775807' }],
        big: 12n,
      },
    ];
    const [header, , row] = tableLines({ rows, row_count: 1, truncated: false });
    const cells = rowCells(row!);

    expect(rowCells(header!)).toHaveLength(4);
    expect(cells).toEqual(['{"a":1,"b":"x\\|y"}', '[1,2]', '[{"k":"9223372036854775807"}]', '12']);
    // Unescaped, each nested cell parses back to the value structuredContent carries.
    expect(cells.slice(0, 3).map((cell) => JSON.parse(unescapeCell(cell)))).toEqual([
      rows[0]!.st,
      rows[0]!.l,
      rows[0]!.nested,
    ]);
  });

  it('#59 fits the response budget on the escaped content, not the raw text', async () => {
    // Each row is a 20,000-character run of |. Raw, two rows fit the budget;
    // escaped, the content doubles and only the first row fits.
    const rows = [
      { payload: '|'.repeat(20_000), n: 0 },
      { payload: '|'.repeat(20_000), n: 1 },
    ];
    mockCanvasQuery({ resolve: { rows, rowCount: 2, truncated: false, columns: [] } });
    const input = imfDataframeQuery.input.parse({
      canvas_id: 'canvas-abc',
      sql: 'SELECT payload, n FROM spilled_abc123',
    });

    const call = await runToolContract(imfDataframeQuery, input, {
      context: { tenantId: 'test' },
    });
    const result = imfDataframeQuery.output.parse(call.structuredContent);

    expect(JSON.stringify(call).length).toBeLessThanOrEqual(RESPONSE_ENVELOPE_CHAR_LIMIT);
    expect(result).toEqual({ rows: rows.slice(0, 1), row_count: 1, truncated: true });
    // structuredContent keeps the raw text; only content[] carries the escapes.
    expect(result.rows[0]?.payload).toBe('|'.repeat(20_000));
    const [, , row] = tableLines(result);
    expect(rowCells(row!)).toHaveLength(2);
  });

  it('#59 serves a single row that overflows only once escaped, clipping its cell in content[] alone', async () => {
    // 0.4.3 rendered this row unescaped (~60,000 serialized characters); escaped,
    // each | costs three, so the whole row would need ~120,000.
    const rows = [{ payload: '|'.repeat(30_000) }];
    mockCanvasQuery({ resolve: { rows, rowCount: 1, truncated: false, columns: [] } });
    const input = imfDataframeQuery.input.parse({
      canvas_id: 'canvas-abc',
      sql: "SELECT repeat('|', 30000) AS payload FROM spilled_abc123 LIMIT 1",
    });

    const call = await runToolContract(imfDataframeQuery, input, {
      context: { tenantId: 'test' },
    });

    expect(call.isError).not.toBe(true);
    // structuredContent is the row exactly as queried, byte for byte.
    expect(JSON.stringify(call.structuredContent)).toBe(
      JSON.stringify({ rows, row_count: 1, truncated: false }),
    );
    expect(imfDataframeQuery.output.parse(call.structuredContent)).toEqual({
      rows,
      row_count: 1,
      truncated: false,
    });
    // The clip spends the budget left after structuredContent: within one escaped
    // character (three serialized) of the cap.
    const envelope = JSON.stringify(call).length;
    expect(envelope).toBeLessThanOrEqual(RESPONSE_ENVELOPE_CHAR_LIMIT);
    expect(envelope).toBeGreaterThan(RESPONSE_ENVELOPE_CHAR_LIMIT - 10);

    const text = (call.content[0] as { text: string }).text;
    const [header, separator, row, ...rest] = text
      .split('\n')
      .filter((line) => line.startsWith('|'));
    expect(rest).toEqual([]);
    expect(header).toBe('| payload |');
    expect(separator).toBe('| :--- |');
    const cells = rowCells(row!);
    expect(cells).toHaveLength(1);
    const clip = cells[0]!.match(/^(.*) … \[clipped: (\d+) of 30000 characters\]$/);
    expect(clip).not.toBeNull();
    const shown = Number(clip![2]);
    expect(shown).toBeGreaterThan(10_000);
    expect(unescapeCell(clip![1]!)).toBe('|'.repeat(shown));
    expect(text).toContain(
      '_**Clipped** — long values in "payload" are cut short in this table to fit the response budget; structuredContent.rows carries every value whole. Read the rest with SUBSTR(column, start, length) in a follow-up query._',
    );
    expect(text).not.toMatch(/truncated/i);
  });

  it('#59 shares the clip among a row’s long cells and leaves its short cells whole', async () => {
    const rows = [
      {
        pipes: '|'.repeat(30_000),
        tag: 'E',
        ticks: '`'.repeat(30_000),
        empty: null,
        nested: { note: '\\|`'.repeat(10) },
        list: Array.from({ length: 5_000 }, (_, i) => i),
      },
    ];
    mockCanvasQuery({ resolve: { rows, rowCount: 1, truncated: false, columns: [] } });
    const input = imfDataframeQuery.input.parse({
      canvas_id: 'canvas-abc',
      sql: 'SELECT * FROM spilled_abc123',
    });

    const call = await runToolContract(imfDataframeQuery, input, {
      context: { tenantId: 'test' },
    });

    expect(call.isError).not.toBe(true);
    expect(JSON.stringify(call.structuredContent)).toBe(
      JSON.stringify({ rows, row_count: 1, truncated: false }),
    );
    expect(JSON.stringify(call).length).toBeLessThanOrEqual(RESPONSE_ENVELOPE_CHAR_LIMIT);

    const text = (call.content[0] as { text: string }).text;
    const [, , row] = text.split('\n').filter((line) => line.startsWith('|'));
    const cells = rowCells(row!);
    expect(cells).toHaveLength(6);
    expect(cells[1]).toBe('E');
    expect(cells[3]).toBe('—');
    const pipes = cells[0]!.match(/^(.*) … \[clipped: (\d+) of 30000 characters\]$/);
    const ticks = cells[2]!.match(/^(.*) … \[clipped: (\d+) of 30000 characters\]$/);
    expect(unescapeCell(pipes![1]!)).toBe('|'.repeat(Number(pipes![2])));
    expect(unescapeCell(ticks![1]!)).toBe('`'.repeat(Number(ticks![2])));
    // One cap for every long cell: the two equal-width runs show the same count.
    expect(pipes![2]).toBe(ticks![2]);
    // The short STRUCT cell stays whole and parses back to its value.
    expect(JSON.parse(unescapeCell(cells[4]!))).toEqual(rows[0]!.nested);
    // The long LIST cell is clipped on its compact JSON, the text the cell shows.
    const listJson = JSON.stringify(rows[0]!.list);
    const list = cells[5]!.match(/^(.*) … \[clipped: (\d+) of (\d+) characters\]$/);
    expect(Number(list![3])).toBe(listJson.length);
    expect(list![1]).toBe(listJson.slice(0, Number(list![2])));
    // Clipped to the same rendered length as the escaped runs, which spend two
    // rendered characters per character shown (one more when the cap is odd).
    expect(Number(list![2]) - 2 * Number(pipes![2])).toBeOneOf([0, 1]);
    expect(text).toContain('long values in "pipes", "ticks", "list" are cut short');
  });

  it('#59 serves a one-row result whose column name overflows once escaped, clipping its header label', async () => {
    // 0.4.3 rendered this alias unescaped; escaped, the header alone would need ~90,000.
    const name = '|'.repeat(30_000);
    const rows = [{ [name]: 1 }];
    mockCanvasQuery({ resolve: { rows, rowCount: 1, truncated: false, columns: [] } });
    const input = imfDataframeQuery.input.parse({
      canvas_id: 'canvas-abc',
      sql: `SELECT 1 AS "${name}" FROM spilled_abc123 LIMIT 1`,
    });

    const call = await runToolContract(imfDataframeQuery, input, {
      context: { tenantId: 'test' },
    });

    expect(call.isError).not.toBe(true);
    expect(JSON.stringify(call.structuredContent)).toBe(
      JSON.stringify({ rows, row_count: 1, truncated: false }),
    );
    // The label clip spends the budget left after structuredContent.
    const envelope = JSON.stringify(call).length;
    expect(envelope).toBeLessThanOrEqual(RESPONSE_ENVELOPE_CHAR_LIMIT);
    expect(envelope).toBeGreaterThan(RESPONSE_ENVELOPE_CHAR_LIMIT - 10);

    const text = (call.content[0] as { text: string }).text;
    const [header, separator, row, ...rest] = text
      .split('\n')
      .filter((line) => line.startsWith('|'));
    expect(rest).toEqual([]);
    expect(separator).toBe('| :--- |');
    expect(rowCells(row!)).toEqual(['1']);
    const headerCells = rowCells(header!);
    expect(headerCells).toHaveLength(1);
    const clip = headerCells[0]!.match(/^(.*) … \[clipped: (\d+) of 30000 characters\]$/);
    expect(clip).not.toBeNull();
    expect(unescapeCell(clip![1]!)).toBe('|'.repeat(Number(clip![2])));
    expect(text).toContain(
      "_**Clipped** — the long name of column 1 is cut short in the header row to fit the response budget; each column's full name is its key in structuredContent.rows._",
    );
  });

  it('#59 names every clipped column name by position, leaving a short name whole', () => {
    const rows = [{ ['|'.repeat(20_000)]: 1, tag: 'E', ['\\'.repeat(20_000)]: 3 }];
    const result = { rows, row_count: 1, truncated: false };

    const text = (imfDataframeQuery.format!(result)[0] as { text: string }).text;

    expect(serializedSuccessEnvelopeLength(result)).toBeLessThanOrEqual(
      RESPONSE_ENVELOPE_CHAR_LIMIT,
    );
    const [header, , row] = tableLines(result);
    const labels = rowCells(header!);
    expect(labels).toHaveLength(3);
    expect(labels[0]).toMatch(/^(\\\|)+ … \[clipped: \d+ of 20000 characters\]$/);
    expect(labels[1]).toBe('tag');
    expect(labels[2]).toMatch(/^(\\\\)+ … \[clipped: \d+ of 20000 characters\]$/);
    expect(rowCells(row!)).toEqual(['1', 'E', '3']);
    expect(text).toContain(
      "_**Clipped** — the long names of columns 1 and 3 are cut short in the header row to fit the response budget; each column's full name is its key in structuredContent.rows._",
    );
  });

  it('#59 names a column by position when both its name and its value are clipped', async () => {
    const name = '`'.repeat(20_000);
    const rows = [{ [name]: '|'.repeat(20_000), tag: 'E' }];
    mockCanvasQuery({ resolve: { rows, rowCount: 1, truncated: false, columns: [] } });
    const input = imfDataframeQuery.input.parse({
      canvas_id: 'canvas-abc',
      sql: 'SELECT * FROM spilled_abc123',
    });

    const call = await runToolContract(imfDataframeQuery, input, {
      context: { tenantId: 'test' },
    });

    expect(call.isError).not.toBe(true);
    expect(JSON.stringify(call.structuredContent)).toBe(
      JSON.stringify({ rows, row_count: 1, truncated: false }),
    );
    expect(JSON.stringify(call).length).toBeLessThanOrEqual(RESPONSE_ENVELOPE_CHAR_LIMIT);

    const text = (call.content[0] as { text: string }).text;
    const [header, , row] = text.split('\n').filter((line) => line.startsWith('|'));
    const headerCells = rowCells(header!);
    expect(headerCells).toHaveLength(2);
    expect(headerCells[0]).toMatch(/^(\\`)+ … \[clipped: \d+ of 20000 characters\]$/);
    expect(headerCells[1]).toBe('tag');
    const cells = rowCells(row!);
    expect(cells[0]).toMatch(/^(\\\|)+ … \[clipped: \d+ of 20000 characters\]$/);
    expect(cells[1]).toBe('E');
    // The note never echoes the long name: the column is named by its position.
    expect(text).toContain(
      "_**Clipped** — long values in column 1 are cut short in this table to fit the response budget; structuredContent.rows carries every value whole. Read the rest with SUBSTR(column, start, length) in a follow-up query. The long name of column 1 is cut short in the header row; each column's full name is its key in structuredContent.rows._",
    );
  });

  it('#59 drops rows before it clips one, and clips the oversized row once it pages alone', async () => {
    const small = { payload: 'x', n: 0 };
    const big = { payload: '|'.repeat(30_000), n: 1 };
    const call = async (rows: Array<Record<string, unknown>>) => {
      mockCanvasQuery({ resolve: { rows, rowCount: rows.length, truncated: false, columns: [] } });
      const input = imfDataframeQuery.input.parse({
        canvas_id: 'canvas-abc',
        sql: 'SELECT payload, n FROM spilled_abc123 ORDER BY n LIMIT 100 OFFSET 0',
      });
      return await runToolContract(imfDataframeQuery, input, { context: { tenantId: 'test' } });
    };

    // Page 1: the small row fits whole; the big one is left for the next page.
    const first = await call([small, big]);
    expect(first.structuredContent).toEqual({ rows: [small], row_count: 1, truncated: true });
    const firstText = (first.content[0] as { text: string }).text;
    expect(firstText).not.toContain('Clipped');
    expect(firstText).toContain('| x | 0 |');

    // Page 2 (OFFSET 1): the big row alone is served, clipped only in content[].
    const second = await call([big]);
    expect(second.isError).not.toBe(true);
    expect(second.structuredContent).toEqual({ rows: [big], row_count: 1, truncated: false });
    const secondText = (second.content[0] as { text: string }).text;
    const [, , row] = secondText.split('\n').filter((line) => line.startsWith('|'));
    expect(rowCells(row!)).toHaveLength(2);
    expect(rowCells(row!)[1]).toBe('1');
    expect(secondText).toContain('long values in "payload" are cut short');

    // A big first row ahead of others: served alone, clipped, and marked truncated.
    const lead = await call([big, small]);
    expect(lead.structuredContent).toEqual({ rows: [big], row_count: 1, truncated: true });
    const leadText = (lead.content[0] as { text: string }).text;
    expect(leadText).toContain('long values in "payload" are cut short');
    expect(leadText).toContain('**Truncated**');
    expect(leadText.indexOf('**Clipped**')).toBeLessThan(leadText.indexOf('**Truncated**'));
  });

  const runQuery = async (rows: Array<Record<string, unknown>>) => {
    mockCanvasQuery({ resolve: { rows, rowCount: rows.length, truncated: false, columns: [] } });
    const input = imfDataframeQuery.input.parse({
      canvas_id: 'canvas-abc',
      sql: 'SELECT * FROM spilled_abc123',
    });
    return await runToolContract(imfDataframeQuery, input, { context: { tenantId: 'test' } });
  };

  it('#59 lists a row too wide for a table even clipped as one name: value line per column', async () => {
    // 0.4.3 served this row (~95,000 characters); escaped, its 1,600 cells cost
    // more than the budget even at the clip marker's length.
    const row = wideRow(1_600, '|'.repeat(16));
    expect(previousReleaseEnvelopeLength(row)).toBeLessThanOrEqual(RESPONSE_ENVELOPE_CHAR_LIMIT);

    const call = await runQuery([row]);

    expect(call.isError).not.toBe(true);
    expect(imfDataframeQuery.output.parse(call.structuredContent)).toEqual({
      rows: [row],
      row_count: 1,
      truncated: false,
    });
    expect(JSON.stringify(call).length).toBeLessThanOrEqual(RESPONSE_ENVELOPE_CHAR_LIMIT);

    const text = (call.content[0] as { text: string }).text;
    expect(text.startsWith(`**1 row**\n\n${ROW_BLOCK_NOTE}\n\n\`\`\`\n`)).toBe(true);
    expect(text).not.toMatch(/^\|/m);
    expect(text).not.toMatch(/Clipped|Truncated/);
    const { fence, lines } = rowBlock(text);
    expect(fence).toBe('```');
    expect(text.endsWith(`\n${fence}`)).toBe(true);
    // Every column name and value is recoverable, in column order, unescaped.
    expect(lines).toEqual(Object.keys(row).map((col) => `${col}: ${'|'.repeat(16)}`));
  });

  it('#59 pages a too-wide result one row at a time, listing the row and marking the page truncated', async () => {
    const rows = [wideRow(1_600, '|'.repeat(16)), wideRow(1_600, '`'.repeat(16))];

    const call = await runQuery(rows);

    expect(call.isError).not.toBe(true);
    expect(imfDataframeQuery.output.parse(call.structuredContent)).toEqual({
      rows: rows.slice(0, 1),
      row_count: 1,
      truncated: true,
    });
    expect(JSON.stringify(call).length).toBeLessThanOrEqual(RESPONSE_ENVELOPE_CHAR_LIMIT);
    const text = (call.content[0] as { text: string }).text;
    // The listing is the first row's, in column order.
    expect(rowBlock(text).lines).toEqual(
      Object.keys(rows[0]!).map((col) => `${col}: ${'|'.repeat(16)}`),
    );
    expect(text).toContain(ROW_BLOCK_NOTE);
    expect(text).toMatch(/\n```\n\n_\*\*Truncated\*\* — capped by the response-size budget/);
  });

  it.each([
    ['backslashes', '\\'.repeat(16)],
    ['double quotes', '"'.repeat(16)],
    ['pipes', '|'.repeat(16)],
    ['backticks', '`'.repeat(16)],
    ['mixed escapes', '\\|`"\\|`"\\|`"\\|`"'],
    ['line breaks', 'a\r\nb\nc\rd\r\ne\nf'],
    ['nulls', null],
    ['four-string LIST', ['a', 'a', 'a', 'a']],
    ['STRUCT', { a: 1, b: 'x|y' }],
    ['integer LIST', [1, 2, 3]],
    ['nested LIST', [[1, 2], [3]]],
    ['LIST of STRUCT', [{ k: 1 }, { k: 2 }]],
    ['empty LIST', []],
    ['LIST holding null and a line break', [null, 'a\nb']],
  ])(
    '#59 serves a one-row result of short %s cells at the 0.4.3 boundary',
    async (_name, value) => {
      // The most columns of this cell 0.4.3 served in one row.
      let count = 1;
      let over = 10_000;
      while (count + 1 < over) {
        const midpoint = Math.floor((count + over) / 2);
        if (
          previousReleaseEnvelopeLength(wideRow(midpoint, value)) <= RESPONSE_ENVELOPE_CHAR_LIMIT
        ) {
          count = midpoint;
        } else {
          over = midpoint;
        }
      }
      expect(previousReleaseEnvelopeLength(wideRow(count + 1, value))).toBeGreaterThan(
        RESPONSE_ENVELOPE_CHAR_LIMIT,
      );
      expect(count).toBeGreaterThan(1_000);
      const row = wideRow(count, value);

      const call = await runQuery([row]);

      expect(call.isError).not.toBe(true);
      expect(imfDataframeQuery.output.parse(call.structuredContent).rows).toEqual([row]);
      expect(JSON.stringify(call).length).toBeLessThanOrEqual(RESPONSE_ENVELOPE_CHAR_LIMIT);
      // Every value reads back from content[], as a table cell or a listed line.
      const text = (call.content[0] as { text: string }).text;
      const flattened = text.includes(FLATTENED_NOTE);
      const shown = (
        typeof value === 'object' && value !== null && !flattened
          ? JSON.stringify(value)
          : previousReleaseText(value)
      ).replace(/\r\n|\r|\n/g, ' ');
      if (/^```/m.test(text)) {
        expect(rowBlock(text).lines).toEqual(Object.keys(row).map((col) => `${col}: ${shown}`));
        // Listed, the row costs no more than the 0.4.3 table did.
        expect(
          serializedSuccessEnvelopeLength({ rows: [row], row_count: 1, truncated: false }),
        ).toBeLessThanOrEqual(previousReleaseEnvelopeLength(row));
      } else {
        const [, , tableRow] = text.split('\n').filter((line) => line.startsWith('|'));
        expect(rowCells(tableRow!).map(unescapeCell)).toEqual(Array(count).fill(shown));
      }
    },
  );

  it('#59 renders the listed row raw: line breaks as spaces, null as —, nested values as JSON, inside a three-backtick fence no line closes', () => {
    const row = {
      ...wideRow(1_600, '|'.repeat(16)),
      ticks: 'a`````b',
      br: 'x\r\ny\nz\rw',
      nul: null,
      st: { a: 1, b: 'x|y' },
      l: [1, 2],
      'multi\nline': 'v',
      quoted: 'say "\\hi\\"',
    };

    const text = (
      imfDataframeQuery.format!({ rows: [row], row_count: 1, truncated: false })[0] as {
        text: string;
      }
    ).text;
    const { fence, lines } = rowBlock(text);

    expect(fence).toBe('```');
    expect(lines.slice(1_600)).toEqual([
      'ticks: a`````b',
      'br: x y z w',
      'nul: —',
      'st: {"a":1,"b":"x|y"}',
      'l: [1,2]',
      'multi line: v',
      'quoted: say "\\hi\\"',
    ]);
    // The nested values fit as JSON, so nothing is flattened.
    expect(text).not.toContain('Flattened');
    expect(text.endsWith('\n```')).toBe(true);
  });

  it('#59 serves a one-row result holding a long backtick run inside a fixed three-backtick fence', async () => {
    // 0.4.3 served this row in 84,001 characters (83,925 without the last two
    // columns); a fence sized past the run costs its length twice more.
    const run = '`'.repeat(12_500);
    const row = {
      ...wideRow(1_000, '|'.repeat(16)),
      ticks: run,
      '```': 'v',
      '````name': '```',
    };
    expect(previousReleaseEnvelopeLength(row)).toBe(84_001);

    const call = await runQuery([row]);

    expect(call.isError).not.toBe(true);
    expect(imfDataframeQuery.output.parse(call.structuredContent)).toEqual({
      rows: [row],
      row_count: 1,
      truncated: false,
    });
    expect(JSON.stringify(call).length).toBeLessThanOrEqual(RESPONSE_ENVELOPE_CHAR_LIMIT);
    const text = (call.content[0] as { text: string }).text;
    expect(text).toContain(ROW_BLOCK_NOTE);
    // Read by the CommonMark fence rules, no line closes the block early: a value
    // that is a backtick run and names that open with backticks all stay inside.
    const { fence, lines } = rowBlock(text);
    expect(fence).toBe('```');
    expect(lines).toEqual([
      ...Object.keys(wideRow(1_000, '')).map((col) => `${col}: ${'|'.repeat(16)}`),
      `ticks: ${run}`,
      '```: v',
      '````name: ```',
    ]);
    expect(text.endsWith('\n```')).toBe(true);
  });

  it('#59 flattens nested values in the listed row as 0.4.3 rendered them when their JSON would not fit', async () => {
    // 2,000 four-string LIST columns: 0.4.3 served the row in 99,904 characters,
    // and as JSON the listed row would cost 118,083.
    const row = wideRow(2_000, ['a', 'a', 'a', 'a']);
    expect(previousReleaseEnvelopeLength(row)).toBe(99_904);

    const call = await runQuery([row]);

    expect(call.isError).not.toBe(true);
    expect(JSON.stringify(call.structuredContent)).toBe(
      JSON.stringify({ rows: [row], row_count: 1, truncated: false }),
    );
    expect(JSON.stringify(call).length).toBeLessThanOrEqual(RESPONSE_ENVELOPE_CHAR_LIMIT);
    const text = (call.content[0] as { text: string }).text;
    expect(rowBlock(text).lines).toEqual(Object.keys(row).map((col) => `${col}: a,a,a,a`));
    expect(text.endsWith(`\n\`\`\`\n\n${FLATTENED_NOTE}`)).toBe(true);
    expect(text).not.toContain('"a"');
  });

  it('#59 flattens a STRUCT as 0.4.3 did and keeps the disclosure above the truncation note', () => {
    const row = wideRow(1_800, { k: 'v', n: [1, 2] });

    const text = (
      imfDataframeQuery.format!({ rows: [row], row_count: 1, truncated: true })[0] as {
        text: string;
      }
    ).text;

    expect(rowBlock(text).lines.slice(0, 2)).toEqual([
      'c0: [object Object]',
      'c1: [object Object]',
    ]);
    expect(text).toContain(
      `\n\`\`\`\n\n${FLATTENED_NOTE}\n\n_**Truncated** — capped by the response-size budget`,
    );
  });

  it('#59 serves the one-column STRUCT row 0.4.3 served at its boundary, pointing content[] at structuredContent', async () => {
    // 0.4.3 rendered the STRUCT as `[object Object]`; its JSON fills the budget.
    expect(previousReleaseStructBoundary(1)).toBe(99_832);
    const row = wideRow(1, bigStruct(99_832));
    expect(previousReleaseEnvelopeLength(row)).toBe(RESPONSE_ENVELOPE_CHAR_LIMIT);

    const call = await runQuery([row]);

    expect(call.isError).not.toBe(true);
    expect(JSON.stringify(call.structuredContent)).toBe(
      JSON.stringify({ rows: [row], row_count: 1, truncated: false }),
    );
    expect(call.content).toEqual([{ type: 'text', text: POINTER_TEXT }]);
    expect(JSON.stringify(call).length).toBeLessThanOrEqual(RESPONSE_ENVELOPE_CHAR_LIMIT);
  });

  it.each(Array.from({ length: 40 }, (_, index) => index + 1))(
    '#59 serves %i STRUCT columns at their 0.4.3 boundary',
    async (count) => {
      const row = wideRow(count, bigStruct(previousReleaseStructBoundary(count)));
      expect(previousReleaseEnvelopeLength(row)).toBeLessThanOrEqual(RESPONSE_ENVELOPE_CHAR_LIMIT);

      const call = await runQuery([row]);

      expect(call.isError).not.toBe(true);
      expect(JSON.stringify(call.structuredContent)).toBe(
        JSON.stringify({ rows: [row], row_count: 1, truncated: false }),
      );
      expect(JSON.stringify(call).length).toBeLessThanOrEqual(RESPONSE_ENVELOPE_CHAR_LIMIT);
      // Listed flattened wherever that listing fits the budget; pointed at only where it does not.
      const listed = [
        `**1 row**\n\n${ROW_BLOCK_NOTE}\n\n\`\`\``,
        ...Object.keys(row).map((col) => `${col}: [object Object]`),
        `\`\`\`\n\n${FLATTENED_NOTE}`,
      ].join('\n');
      const listedFits =
        JSON.stringify({
          structuredContent: { rows: [row], row_count: 1, truncated: false },
          content: [{ type: 'text', text: listed }],
        }).length <= RESPONSE_ENVELOPE_CHAR_LIMIT;
      expect(call.content).toEqual([{ type: 'text', text: listedFits ? listed : POINTER_TEXT }]);
    },
  );

  it('#59 keeps the truncation note under the pointer when rows were dropped', async () => {
    const row = wideRow(1, bigStruct(99_600));
    const pointed = `${POINTER_TEXT}\n\n_**Truncated** — capped by the response-size budget or canvas row limit, and more rows may match. Page the remainder with a stable ORDER BY plus LIMIT/OFFSET, or narrow the query._`;

    expect(imfDataframeQuery.format!({ rows: [row], row_count: 1, truncated: true })).toEqual([
      { type: 'text', text: pointed },
    ]);

    const call = await runQuery([row, row]);

    expect(call.isError).not.toBe(true);
    expect(imfDataframeQuery.output.parse(call.structuredContent)).toEqual({
      rows: [row],
      row_count: 1,
      truncated: true,
    });
    expect(call.content).toEqual([{ type: 'text', text: pointed }]);
    expect(JSON.stringify(call).length).toBeLessThanOrEqual(RESPONSE_ENVELOPE_CHAR_LIMIT);
  });

  it('#59 points no longer than the cheapest 0.4.3 table of a row that can reach the pointer', () => {
    // A cell under 15 characters carries too little JSON to reach the pointer, so the
    // cheapest such table is one `[object Object]` column; an empty name undercuts
    // DuckDB, which rejects zero-length identifiers.
    const pointerLength = JSON.stringify(
      imfDataframeQuery.format!({
        rows: [{ payload: 'x'.repeat(RESPONSE_ENVELOPE_CHAR_LIMIT) }],
        row_count: 1,
        truncated: false,
      }),
    ).length;
    const cheapestPrevious =
      previousReleaseEnvelopeLength({ '': {} }) -
      JSON.stringify({ structuredContent: { rows: [{ '': {} }], row_count: 1, truncated: false } })
        .length -
      ',"content":'.length;

    expect(cheapestPrevious).toBe(pointerLength);
    expect(pointerLength).toBe(75);
  });

  it('#59 serves a row whose structuredContent with the pointer is exactly the budget, and refuses one character more', async () => {
    const served = await runQuery([{ payload: 'x'.repeat(99_835) }]);

    expect(served.isError).not.toBe(true);
    expect(served.content).toEqual([{ type: 'text', text: POINTER_TEXT }]);
    expect(JSON.stringify(served).length).toBe(RESPONSE_ENVELOPE_CHAR_LIMIT);

    const refused = contractError(await runQuery([{ payload: 'x'.repeat(99_836) }]));
    expect(refused.data?.reason).toBe('response_too_large');
    expect(refused.message).toContain('as structured content alone');
  });

  it.each([
    ['plain text', 'abcdefgh'],
    ['backslashes', '\\'.repeat(8)],
    ['double quotes', '"'.repeat(8)],
    ['pipes', '|'.repeat(8)],
    ['backticks', '`'.repeat(8)],
    ['line breaks', 'a\r\nb\nc'],
    ['nulls', null],
    ['numbers', 3.25],
    ['booleans', true],
    ['BIGINT text', '9223372036854775807'],
    ['four-string LIST', ['a', 'a', 'a', 'a']],
    ['STRUCT', { a: 1, b: 'x|y' }],
    ['LIST of STRUCT', [{ k: 1 }, { k: 2 }]],
    [
      'MAP',
      [
        { key: 'k', value: 'v' },
        { key: 'j', value: 'w' },
      ],
    ],
    ['nested LIST', [[1, 2], [3]]],
    ['empty LIST', []],
  ])(
    '#59 a listed %s column costs at least nine serialized characters less than its 0.4.3 table column',
    (_name, value) => {
      // Every column name has five characters, so each added column costs the same.
      const row = (count: number) =>
        Object.fromEntries(
          Array.from({ length: count }, (_, i) => [`k${String(i).padStart(4, '0')}`, value]),
        );
      const format = (count: number) =>
        imfDataframeQuery.format!({ rows: [row(count)], row_count: 1, truncated: false });
      const previousContentLength = (count: number) =>
        previousReleaseEnvelopeLength(row(count)) -
        JSON.stringify({ rows: [row(count)], row_count: 1, truncated: false }).length;

      // The listing is served only between the counts a table fits at and the counts
      // only the pointer fits at; measure across 100 columns inside that window, in
      // the flattened form wherever a nested value is ever flattened.
      const forms = new Map<number, string | undefined>();
      const listedForm = (count: number) => {
        if (!forms.has(count)) {
          const text = (format(count)[0] as { text: string }).text;
          forms.set(
            count,
            /^```$/m.test(text)
              ? text.includes(FLATTENED_NOTE)
                ? 'flattened'
                : 'json'
              : undefined,
          );
        }
        return forms.get(count);
      };
      const windowStart = (form: string) =>
        Array.from({ length: 98 }, (_, i) => 100 * (i + 1)).find(
          (count) => listedForm(count) === form && listedForm(count + 100) === form,
        );
      const nested = typeof value === 'object' && value !== null;
      const start = (nested ? windowStart('flattened') : undefined) ?? windowStart('json');
      expect(start).toBeDefined();
      const end = start! + 100;
      const flattened = listedForm(end) === 'flattened';

      const { lines } = rowBlock((format(end)[0] as { text: string }).text);
      const shown = nested && !flattened ? JSON.stringify(value) : previousReleaseText(value);
      expect(lines.at(-1)).toBe(
        `k${String(end - 1).padStart(4, '0')}: ${shown.replace(/\r\n|\r|\n/g, ' ')}`,
      );

      const listed = JSON.stringify(format(end)).length - JSON.stringify(format(start!)).length;
      const previous = previousContentLength(end) - previousContentLength(start!);
      expect(listed).toBeLessThanOrEqual(previous - 9 * 100);
    },
  );

  // -------------------------------------------------------------------------
  // #9: canvas_not_found recovery text
  // -------------------------------------------------------------------------

  it('canvas_not_found recovery tells caller to re-run imf_query_dataset', () => {
    // Verify the error contract recovery no longer includes the provider hint
    const recovery =
      imfDataframeQuery.errors?.find((e) => e.reason === 'canvas_not_found')?.recovery ?? '';
    expect(recovery).toContain('imf_query_dataset');
    expect(recovery).not.toContain('CANVAS_PROVIDER_TYPE');
  });

  // -------------------------------------------------------------------------
  // #16: DataCanvas truncation is surfaced, not swallowed
  // -------------------------------------------------------------------------

  it('#16 surfaces truncated=true when DataCanvas caps the result', async () => {
    // DataCanvas sets truncated without reporting a pre-cap total. The server's
    // row_count remains the number of rows it actually returns.
    mockCanvasQuery({
      resolve: { rows: MOCK_ROWS, rowCount: MOCK_ROWS.length, truncated: true, columns: [] },
    });
    const ctx = createMockContext({ tenantId: 'test', errors: imfDataframeQuery.errors });
    const input = imfDataframeQuery.input.parse({
      canvas_id: 'canvas-abc',
      sql: 'SELECT * FROM spilled_abc123',
    });

    const result = await imfDataframeQuery.handler(input, ctx);
    expect(result.truncated).toBe(true);
    expect(result.row_count).toBe(MOCK_ROWS.length);
    expect(result.row_count).toBe(result.rows.length);
  });

  it('#16 reports truncated=false when DataCanvas omits the flag', async () => {
    mockCanvasQuery({ resolve: { rows: MOCK_ROWS, rowCount: 2, columns: [] } });
    const ctx = createMockContext({ tenantId: 'test', errors: imfDataframeQuery.errors });
    const input = imfDataframeQuery.input.parse({
      canvas_id: 'canvas-abc',
      sql: 'SELECT * FROM spilled_abc123',
    });

    const result = await imfDataframeQuery.handler(input, ctx);
    expect(result.truncated).toBe(false);
  });

  it('#16 format() tells the caller the result is capped and how to page it', () => {
    const text = (
      imfDataframeQuery.format!({
        rows: MOCK_ROWS as Array<Record<string, unknown>>,
        row_count: 10_000,
        truncated: true,
      })[0] as { text: string }
    ).text;

    expect(text).toMatch(/truncated/i);
    expect(text).toContain('capped');
    expect(text).toContain('ORDER BY');
    expect(text).toContain('OFFSET');
  });

  it('#16 format() adds no truncation note when the result is complete', () => {
    const text = (
      imfDataframeQuery.format!({
        rows: MOCK_ROWS as Array<Record<string, unknown>>,
        row_count: 2,
        truncated: false,
      })[0] as { text: string }
    ).text;

    // A complete result says nothing about truncation — the common case stays quiet.
    expect(text).not.toMatch(/truncated/i);
    expect(text).not.toContain('capped');
    expect(text).not.toContain('OFFSET');
  });

  it('#16 row_count description does not claim a pre-cap total', () => {
    const description = imfDataframeQuery.output.shape.row_count.description ?? '';
    expect(description).not.toMatch(/before the cap|may exceed/i);
    expect(description).toMatch(/materialized/i);
  });

  // -------------------------------------------------------------------------
  // #38: the complete two-channel response stays within its character budget
  // -------------------------------------------------------------------------

  it('#38 caps a 10,000-row dual-channel success envelope at 100,000 characters', async () => {
    const rows = Array.from({ length: 10_000 }, (_, index) => ({
      series_key: `USA.NGDP_RPCH.A.${index}`,
      time_period: String(2000 + (index % 100)),
      value: index / 10,
      status: index % 2 === 0 ? null : 'E',
    }));
    mockCanvasQuery({ resolve: { rows, rowCount: rows.length, truncated: false, columns: [] } });
    const input = imfDataframeQuery.input.parse({
      canvas_id: 'canvas-abc',
      sql: 'SELECT * FROM spilled_abc123 ORDER BY series_key',
    });

    const call = await runToolContract(imfDataframeQuery, input, {
      context: { tenantId: 'test' },
    });
    const result = imfDataframeQuery.output.parse(call.structuredContent);

    expect(JSON.stringify(call).length).toBeLessThanOrEqual(RESPONSE_ENVELOPE_CHAR_LIMIT);
    expect(result.row_count).toBe(result.rows.length);
    expect(result.truncated).toBe(true);
    expect(result.rows).toEqual(rows.slice(0, result.row_count));
    expect(
      serializedSuccessEnvelopeLength({
        rows: rows.slice(0, result.row_count + 1),
        row_count: result.row_count + 1,
        truncated: true,
      }),
    ).toBeGreaterThan(RESPONSE_ENVELOPE_CHAR_LIMIT);

    const content = JSON.stringify(imfDataframeQuery.format!(result));
    expect(content).toContain(String(result.rows.at(-1)?.series_key));
    expect(content).not.toContain(String(rows[result.row_count]?.series_key));
  });

  it('#38 keeps a complete result whose emitted envelope is exactly 100,000 characters', async () => {
    const rows = [{ payload: 'x'.repeat(49_911), n: 0 }];
    mockCanvasQuery({ resolve: { rows, rowCount: 1, truncated: false, columns: [] } });
    const input = imfDataframeQuery.input.parse({
      canvas_id: 'canvas-abc',
      sql: 'SELECT payload, n FROM spilled_abc123',
    });

    const call = await runToolContract(imfDataframeQuery, input, {
      context: { tenantId: 'test' },
    });
    const result = imfDataframeQuery.output.parse(call.structuredContent);

    expect(JSON.stringify(call).length).toBe(RESPONSE_ENVELOPE_CHAR_LIMIT);
    expect(result).toEqual({ rows, row_count: 1, truncated: false });
  });

  it('#38 #59 serves a single row one character past the boundary, clipping its long cell', async () => {
    const rows = [{ payload: 'x'.repeat(49_912), n: 0 }];
    mockCanvasQuery({ resolve: { rows, rowCount: 1, truncated: false, columns: [] } });
    const input = imfDataframeQuery.input.parse({
      canvas_id: 'canvas-abc',
      sql: 'SELECT payload, n FROM spilled_abc123',
    });

    const call = await runToolContract(imfDataframeQuery, input, {
      context: { tenantId: 'test' },
    });

    expect(call.isError).not.toBe(true);
    expect(imfDataframeQuery.output.parse(call.structuredContent)).toEqual({
      rows,
      row_count: 1,
      truncated: false,
    });
    const envelope = JSON.stringify(call).length;
    expect(envelope).toBeLessThanOrEqual(RESPONSE_ENVELOPE_CHAR_LIMIT);
    expect(envelope).toBeGreaterThan(RESPONSE_ENVELOPE_CHAR_LIMIT - 10);
    // Read from the content[] the caller receives: the clip shows exactly the count it names.
    const text = (call.content[0] as { text: string }).text;
    const [header, separator, row, ...rest] = text
      .split('\n')
      .filter((line) => line.startsWith('|'));
    expect([header, separator, rest]).toEqual(['| payload | n |', '| :--- | :--- |', []]);
    const cells = rowCells(row!);
    expect(cells).toHaveLength(2);
    const clip = cells[0]!.match(/^(x*) … \[clipped: (\d+) of 49912 characters\]$/);
    expect(clip).not.toBeNull();
    expect(clip![1]).toBe('x'.repeat(Number(clip![2])));
    expect(cells[1]).toBe('0');
  });

  it.each([
    ['its structuredContent alone exceeds the budget', [{ payload: 'x'.repeat(100_000), n: 0 }]],
    [
      'the structuredContent of its 6,000 short cells alone exceeds the budget',
      [
        Object.fromEntries(
          Array.from({ length: 6_000 }, (_, i) => [`c${String(i).padStart(4, '0')}`, 'abcdefgh']),
        ),
      ],
    ],
  ])(
    '#38 rejects a single row that cannot fit even with content[] reduced to a pointer, with actionable recovery: %s',
    async (_name, rows) => {
      mockCanvasQuery({ resolve: { rows, rowCount: 1, truncated: false, columns: [] } });
      const input = imfDataframeQuery.input.parse({
        canvas_id: 'canvas-abc',
        sql: 'SELECT * FROM spilled_abc123',
      });

      const error = contractError(
        await runToolContract(imfDataframeQuery, input, { context: { tenantId: 'test' } }),
      );

      expect(error.code).toBe(JsonRpcErrorCode.SerializationError);
      expect(error.data?.reason).toBe('response_too_large');
      expect(error.data?.recovery).toMatchObject({
        hint: expect.stringMatching(/fewer columns|aggregate|shorter values/i),
      });
    },
  );

  it('#38 reports an exhausted empty page as complete', async () => {
    mockCanvasQuery({ resolve: { rows: [], rowCount: 0, truncated: false, columns: [] } });
    const ctx = createMockContext({ tenantId: 'test', errors: imfDataframeQuery.errors });
    const input = imfDataframeQuery.input.parse({
      canvas_id: 'canvas-abc',
      sql: 'SELECT * FROM spilled_abc123 ORDER BY series_key LIMIT 100 OFFSET 10000',
    });

    const result = await imfDataframeQuery.handler(input, ctx);
    const text = (imfDataframeQuery.format!(result)[0] as { text: string }).text;

    expect(result).toEqual({ rows: [], row_count: 0, truncated: false });
    expect(text).not.toContain('OFFSET');
    expect(text).not.toMatch(/truncated/i);
  });

  // -------------------------------------------------------------------------
  // #17: missing_table is translated into the tool's own contract
  // -------------------------------------------------------------------------

  it('#17 translates the canvas missing_table error into a declared reason', async () => {
    mockCanvasQuery({
      reject: new McpError(
        JsonRpcErrorCode.NotFound,
        'Canvas table "spilled_gone" does not exist. The table may have expired or been dropped — re-stage it or call describe() to inspect the canvas.',
        {
          reason: 'missing_table',
          tableName: 'spilled_gone',
          recovery: {
            hint: 'Re-stage the table via registerTable() or call describe() to see what tables are currently available.',
          },
        },
      ),
    });
    const input = imfDataframeQuery.input.parse({
      canvas_id: 'canvas-abc',
      sql: 'SELECT * FROM spilled_gone',
    });

    const call = await runToolContract(imfDataframeQuery, input, {
      context: { tenantId: 'test' },
    });
    const err = contractError(call);

    // Distinct from canvas_not_found — the canvas exists, the table does not.
    expect(err.code).toBe(JsonRpcErrorCode.NotFound);
    expect(err.data?.reason).toBe('missing_table');
    expect(err.data?.tableName).toBe('spilled_gone');

    // Nothing the caller reads, on either surface, may name a framework method it cannot call.
    const wire = JSON.stringify(call);
    expect(wire).not.toContain('registerTable');
    expect(wire).not.toContain('describe()');
    expect(wire).toContain('imf_dataframe_describe');
    expect(wire).toContain('imf_query_dataset');
  });

  it('#17 advertises missing_table in the errors contract', () => {
    const entry = imfDataframeQuery.errors?.find((e) => e.reason === 'missing_table');
    expect(entry?.code).toBe(JsonRpcErrorCode.NotFound);
    expect(entry?.recovery).toContain('imf_dataframe_describe');
    expect(entry?.recovery).not.toContain('registerTable');
  });

  // -------------------------------------------------------------------------
  // #25: WITH … SELECT accepted; invalid_sql covers both rejection paths
  // -------------------------------------------------------------------------

  it('#25 accepts a WITH … SELECT common table expression', async () => {
    const query = mockCanvasQuery({ resolve: { rows: [], rowCount: 0, columns: [] } });
    const ctx = createMockContext({ tenantId: 'test', errors: imfDataframeQuery.errors });
    const sql =
      'WITH ranked AS (SELECT series_key, avg(value) AS avg_growth FROM spilled_abc123 GROUP BY 1) ' +
      'SELECT series_key, round(avg_growth, 2) FROM ranked ORDER BY avg_growth DESC LIMIT 5';
    const input = imfDataframeQuery.input.parse({ canvas_id: 'canvas-abc', sql });

    await expect(imfDataframeQuery.handler(input, ctx)).resolves.toBeDefined();
    // The statement reached the canvas verbatim — the local gate did not rewrite it.
    expect(query).toHaveBeenCalledWith(sql, expect.anything());
  });

  it('#25 accepts a lowercase, leading-whitespace CTE', async () => {
    mockCanvasQuery({ resolve: { rows: [], rowCount: 0, columns: [] } });
    const ctx = createMockContext({ tenantId: 'test', errors: imfDataframeQuery.errors });
    const input = imfDataframeQuery.input.parse({
      canvas_id: 'canvas-abc',
      sql: '\n  with r as (select 1 as x) select * from r',
    });

    await expect(imfDataframeQuery.handler(input, ctx)).resolves.toBeDefined();
  });

  it('#25 still rejects DML/DDL before canvas acquisition (#2 stays fixed)', async () => {
    // Canvas disabled — the local shape check must still produce invalid_sql.
    (getCanvas as ReturnType<typeof vi.fn>).mockReturnValue(undefined);
    const ctx = createMockContext({ tenantId: 'test', errors: imfDataframeQuery.errors });

    for (const sql of [
      'DROP TABLE t',
      'INSERT INTO t VALUES (1)',
      'UPDATE t SET x = 1',
      'PRAGMA',
    ]) {
      const input = imfDataframeQuery.input.parse({ canvas_id: 'canvas-abc', sql });
      await expect(imfDataframeQuery.handler(input, ctx)).rejects.toMatchObject({
        code: JsonRpcErrorCode.ValidationError,
        data: { reason: 'invalid_sql' },
      });
    }
  });

  it('#25 translates a SELECT-shaped prepare failure into invalid_sql with a recovery hint', async () => {
    mockCanvasQuery({
      reject: new McpError(
        JsonRpcErrorCode.ValidationError,
        'Canvas query failed to prepare: Binder Error: Referenced column "nope" not found in FROM clause!',
        { reason: 'invalid_sql', statementType: 'UNKNOWN', binderMessage: 'Binder Error' },
      ),
    });
    const input = imfDataframeQuery.input.parse({
      canvas_id: 'canvas-abc',
      sql: 'SELECT nope FROM spilled_abc123',
    });

    const err = contractError(
      await runToolContract(imfDataframeQuery, input, { context: { tenantId: 'test' } }),
    );

    expect(err.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(err.data?.reason).toBe('invalid_sql');
    // The framework path previously arrived with no hint at all.
    expect(err.data?.recovery).toMatchObject({
      hint: expect.stringContaining('imf_dataframe_describe'),
    });
    // The binder detail the caller needs to fix the query survives.
    expect(err.message).toContain('nope');
  });

  it('#25 invalid_sql contract covers both the shape check and the prepare failure', () => {
    const entry = imfDataframeQuery.errors?.find((e) => e.reason === 'invalid_sql');
    expect(entry?.when).toMatch(/WITH/);
    expect(entry?.when).toMatch(/prepare/i);
    expect(entry?.recovery).toMatch(/WITH/);
  });

  it('#25 sql description and rejection message describe what is actually refused', async () => {
    expect(imfDataframeQuery.input.shape.sql.description).toMatch(/WITH/);
    expect(imfDataframeQuery.input.shape.sql.description).not.toMatch(
      /[Mm]ust start with SELECT\./,
    );

    (getCanvas as ReturnType<typeof vi.fn>).mockReturnValue(undefined);
    const ctx = createMockContext({ tenantId: 'test', errors: imfDataframeQuery.errors });
    const input = imfDataframeQuery.input.parse({
      canvas_id: 'canvas-abc',
      sql: 'DROP TABLE t',
    });
    const err = await captureMcpError(() => imfDataframeQuery.handler(input, ctx));
    expect(err.message).toMatch(/WITH/);
  });

  // -------------------------------------------------------------------------
  // Read-only gate denials share the missing_table problem: no usable hint.
  // -------------------------------------------------------------------------

  it('translates read-only gate denials into the declared sql_not_permitted reason', async () => {
    for (const reason of [
      'denied_function',
      'denied_function_in_plan',
      'plan_operator_not_allowed',
      'system_catalog_access',
      'sql_read_only',
    ]) {
      mockCanvasQuery({
        reject: new McpError(
          JsonRpcErrorCode.ValidationError,
          'Canvas query references a system catalog: information_schema.',
          { reason },
        ),
      });
      const input = imfDataframeQuery.input.parse({
        canvas_id: 'canvas-abc',
        sql: 'SELECT * FROM information_schema.tables',
      });

      const call = await runToolContract(imfDataframeQuery, input, {
        context: { tenantId: 'test' },
      });
      expect(contractError(call)).toMatchObject({
        code: JsonRpcErrorCode.ValidationError,
        data: {
          reason: 'sql_not_permitted',
          recovery: { hint: expect.stringContaining('imf_dataframe_describe') },
        },
      });
    }
  });

  // -------------------------------------------------------------------------
  // #68: file reads and execution failures arrive under declared reasons
  // -------------------------------------------------------------------------

  it('#68 maps sql_read_only onto sql_not_permitted and keeps the engine message', async () => {
    const message =
      'Canvas SQL rejected: Permission Error: Cannot access file "x.csv" - file system operations are disabled by configuration';
    mockCanvasQuery({
      reject: new McpError(JsonRpcErrorCode.ValidationError, message, { reason: 'sql_read_only' }),
    });
    const input = imfDataframeQuery.input.parse({
      canvas_id: 'canvas-abc',
      sql: "SELECT * FROM 'x.csv'",
    });

    const err = contractError(
      await runToolContract(imfDataframeQuery, input, { context: { tenantId: 'test' } }),
    );

    expect(err.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(err.data?.reason).toBe('sql_not_permitted');
    expect(err.data?.canvasId).toBe('canvas-abc');
    expect(err.message).toBe(message);
  });

  it('#68 maps sql_execution_error onto the declared reason with this tool’s recovery', async () => {
    const message =
      "Canvas query failed: Conversion Error: Could not convert string 'USA.CPI.CP01.IX.M' to INT32 when casting from source column series_key";
    mockCanvasQuery({
      reject: new McpError(JsonRpcErrorCode.ValidationError, message, {
        reason: 'sql_execution_error',
      }),
    });
    const input = imfDataframeQuery.input.parse({
      canvas_id: 'canvas-abc',
      sql: 'SELECT CAST(series_key AS INTEGER) FROM spilled_abc123',
    });

    const err = contractError(
      await runToolContract(imfDataframeQuery, input, { context: { tenantId: 'test' } }),
    );

    expect(err.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(err.data?.reason).toBe('sql_execution_error');
    expect(err.data?.canvasId).toBe('canvas-abc');
    expect(err.data?.recovery).toMatchObject({ hint: expect.stringContaining('TRY_CAST') });
    expect(err.message).toBe(message);
  });

  it('#68 declares sql_execution_error and names file reads under sql_not_permitted', () => {
    const execution = imfDataframeQuery.errors?.find((e) => e.reason === 'sql_execution_error');
    expect(execution).toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      severity: 'warning',
      when: 'sql prepares but fails while it runs, such as a failed cast or an arithmetic overflow',
      recovery:
        'Use TRY_CAST for a conversion that can fail, cast to a wider type such as HUGEINT or DOUBLE before arithmetic that can overflow, or filter out the rows the message names.',
    });
    const notPermitted = imfDataframeQuery.errors?.find((e) => e.reason === 'sql_not_permitted');
    expect(notPermitted?.when).toContain('or names a file instead of a staged table');
  });

  it('rethrows an unmapped canvas error untouched rather than mislabeling it', async () => {
    mockCanvasQuery({
      reject: new McpError(
        JsonRpcErrorCode.DatabaseError,
        'EXPLAIN returned an unexpected shape.',
        {
          reason: 'something_new',
        },
      ),
    });
    const ctx = createMockContext({ tenantId: 'test', errors: imfDataframeQuery.errors });
    const input = imfDataframeQuery.input.parse({
      canvas_id: 'canvas-abc',
      sql: 'SELECT 1',
    });

    await expect(imfDataframeQuery.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.DatabaseError,
      data: { reason: 'something_new' },
    });
  });
});

/**
 * The same tool over a real DuckDB-backed canvas, so the value shapes DuckDB's
 * row reader hands the tool and the reasons its error classifier sets are the
 * engine's own, not a stub's.
 */
describe('imfDataframeQuery over a DuckDB canvas', () => {
  let canvas: DataCanvas;
  let exportRoot: string;
  let canvasId: string;
  const table = 'spilled_cpi';

  beforeAll(async () => {
    exportRoot = await mkdtemp(join(tmpdir(), 'imf-dataframe-query-test-'));
    const provider = new DuckdbProvider({
      defaultRowLimit: 10_000,
      exportRootPath: exportRoot,
      memoryLimitMb: 256,
      schemaSniffRows: 100,
    });
    canvas = new DataCanvas(provider, new CanvasRegistry(provider));
    const instance = await canvas.acquire(undefined, createMockContext({ tenantId: 'test' }));
    canvasId = instance.canvasId;
    await instance.registerTable(table, [
      { series_key: 'USA.CPI.CP01.IX.M', time_period: '2024-01', value: 101.5 },
      { series_key: 'USA.CPI.CP01.IX.M', time_period: '2024-02', value: 102.1 },
    ]);
  });

  afterAll(async () => {
    await canvas.shutdown(createMockContext({ tenantId: 'test' }));
    await rm(exportRoot, { recursive: true, force: true });
  });

  beforeEach(() => {
    (getCanvas as ReturnType<typeof vi.fn>).mockReturnValue(canvas);
  });

  const run = (sql: string) =>
    runToolContract(
      imfDataframeQuery,
      imfDataframeQuery.input.parse({ canvas_id: canvasId, sql }),
      {
        context: { tenantId: 'test' },
      },
    );

  const textOf = (call: Awaited<ReturnType<typeof run>>) =>
    (call.content as Array<{ type: string; text: string }>)[0]!.text;

  it('#59 keeps one cell per column for a | in a cell or alias and a line break in a cell', async () => {
    const call = await run(
      `SELECT 'a|b' AS s, 'x' || chr(10) || 'y' AS t, 1 AS "c|d" FROM ${table} LIMIT 1`,
    );

    expect(textOf(call).split('\n').slice(2)).toEqual([
      '| s | t | c\\|d |',
      '| :--- | :--- | :--- |',
      '| a\\|b | x y | 1 |',
    ]);
    expect(imfDataframeQuery.output.parse(call.structuredContent).rows).toEqual([
      { s: 'a|b', t: 'x\ny', 'c|d': 1 },
    ]);
  });

  it('#59 renders DuckDB STRUCT, LIST, and nested BIGINT values as the JSON rows carry them', async () => {
    const call = await run(
      `SELECT {'a': 1, 'b': 'x|y'} AS st, [1, 2] AS l, [{'k': 9223372036854775807::BIGINT}] AS nb FROM ${table} LIMIT 1`,
    );
    const { rows } = imfDataframeQuery.output.parse(call.structuredContent);
    const row = textOf(call).split('\n').at(-1)!;

    expect(rows).toEqual([
      { st: { a: 1, b: 'x|y' }, l: [1, 2], nb: [{ k: '9223372036854775807' }] },
    ]);
    expect(row).toBe('| {"a":1,"b":"x\\|y"} | [1,2] | [{"k":"9223372036854775807"}] |');
  });

  it('#59 lists a 1,600-column row of short | cells one name: value line per column', async () => {
    const columns = Array.from({ length: 1_600 }, (_, i) => `repeat('|', 16) AS c${i}`);
    const call = await run(`SELECT ${columns.join(', ')} FROM ${table} LIMIT 2`);

    expect(call.isError).not.toBe(true);
    expect(JSON.stringify(call).length).toBeLessThanOrEqual(RESPONSE_ENVELOPE_CHAR_LIMIT);
    const result = imfDataframeQuery.output.parse(call.structuredContent);
    expect(result).toMatchObject({ row_count: 1, truncated: true });
    expect(rowBlock(textOf(call)).lines).toEqual(
      Array.from({ length: 1_600 }, (_, i) => `c${i}: ${'|'.repeat(16)}`),
    );
  });

  it('#59 lists a row holding a 12,500-backtick value inside a three-backtick fence', async () => {
    const columns = Array.from({ length: 1_000 }, (_, i) => `repeat('|', 16) AS c${i}`);
    const call = await run(
      `SELECT ${columns.join(', ')}, repeat('\`', 12500) AS ticks, 'v' AS "\`\`\`x" FROM ${table} LIMIT 1`,
    );

    expect(call.isError).not.toBe(true);
    expect(JSON.stringify(call).length).toBeLessThanOrEqual(RESPONSE_ENVELOPE_CHAR_LIMIT);
    const { fence, lines } = rowBlock(textOf(call));
    expect(fence).toBe('```');
    expect(lines.slice(-2)).toEqual([`ticks: ${'`'.repeat(12_500)}`, '```x: v']);
    expect(lines).toHaveLength(1_002);
  });

  it('#59 flattens 2,000 DuckDB LIST columns in the listed row, keeping their structure in rows', async () => {
    const columns = Array.from({ length: 2_000 }, (_, i) => `['a', 'a', 'a', 'a'] AS c${i}`);
    const call = await run(`SELECT ${columns.join(', ')} FROM ${table} LIMIT 1`);

    expect(call.isError).not.toBe(true);
    expect(JSON.stringify(call).length).toBeLessThanOrEqual(RESPONSE_ENVELOPE_CHAR_LIMIT);
    const result = imfDataframeQuery.output.parse(call.structuredContent);
    expect(result).toMatchObject({ row_count: 1, truncated: false });
    expect(result.rows[0]?.c1999).toEqual(['a', 'a', 'a', 'a']);
    const text = textOf(call);
    expect(rowBlock(text).lines).toEqual(Array.from({ length: 2_000 }, (_, i) => `c${i}: a,a,a,a`));
    expect(text.endsWith(FLATTENED_NOTE)).toBe(true);
  });

  it('#59 renders a DuckDB MAP in the listed row as the JSON rows carry, or flattened as 0.4.3 did', async () => {
    const columns = Array.from({ length: 1_600 }, (_, i) => `repeat('|', 16) AS c${i}`);
    const call = await run(`SELECT ${columns.join(', ')}, MAP {'k': 1} AS m FROM ${table} LIMIT 1`);

    const { rows } = imfDataframeQuery.output.parse(call.structuredContent);
    // DuckDB hands a MAP over as a list of key/value entries.
    expect(rows[0]?.m).toEqual([{ key: 'k', value: 1 }]);
    expect(rowBlock(textOf(call)).lines.at(-1)).toBe('m: [{"key":"k","value":1}]');
    expect(
      imfDataframeQuery.format!({
        rows: [wideRow(1_700, rows[0]?.m)],
        row_count: 1,
        truncated: false,
      })[0],
    ).toMatchObject({ text: expect.stringContaining('\nc1699: [object Object]\n```') });
  });

  it.each(["SELECT * FROM 'x.csv'", `SELECT a.* FROM ${table} a JOIN 'y.parquet' b ON 1=1`])(
    '#68 refuses a file read as sql_not_permitted: %s',
    async (sql) => {
      const err = contractError(await run(sql));

      expect(err.code).toBe(JsonRpcErrorCode.ValidationError);
      expect(err.data?.reason).toBe('sql_not_permitted');
      expect(err.message).toMatch(/Cannot access file/);
    },
  );

  it.each([
    `SELECT CAST(series_key AS INTEGER) FROM ${table}`,
    `SELECT 9223372036854775807::BIGINT + 1::BIGINT FROM ${table}`,
  ])('#68 reports a data failure as sql_execution_error: %s', async (sql) => {
    const err = contractError(await run(sql));

    expect(err.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(err.data?.reason).toBe('sql_execution_error');
    expect(err.data?.recovery).toMatchObject({ hint: expect.stringContaining('TRY_CAST') });
    // Raised through this tool's contract, which names the canvas — not passed through.
    expect(err.data?.canvasId).toBe(canvasId);
  });
});
