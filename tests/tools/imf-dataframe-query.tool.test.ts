/**
 * @fileoverview Tests for the imf_dataframe_query tool.
 * @module tests/tools/imf-dataframe-query.tool.test
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { captureMcpError } from '../helpers/errors.js';

vi.mock('@/services/canvas/canvas-accessor.js', () => ({
  getCanvas: vi.fn(),
}));

import { imfDataframeQuery } from '@/mcp-server/tools/definitions/imf-dataframe-query.tool.js';
import { getCanvas } from '@/services/canvas/canvas-accessor.js';

const MOCK_ROWS = [
  { time_period: '2020', value: 3.5, status: null },
  { time_period: '2021', value: 5.1, status: 'E' },
];

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
      canvas_id: 'expired-canvas',
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

  it('#38 rejects a single row that cannot fit with actionable recovery', async () => {
    const rows = [{ payload: 'x'.repeat(49_912), n: 0 }];
    mockCanvasQuery({ resolve: { rows, rowCount: 1, truncated: false, columns: [] } });
    const ctx = createMockContext({ tenantId: 'test', errors: imfDataframeQuery.errors });
    const input = imfDataframeQuery.input.parse({
      canvas_id: 'canvas-abc',
      sql: 'SELECT payload, n FROM spilled_abc123',
    });

    const error = await captureMcpError(() => imfDataframeQuery.handler(input, ctx));

    expect(error.code).toBe(JsonRpcErrorCode.SerializationError);
    expect(error.data?.reason).toBe('response_too_large');
    expect(error.data?.recovery).toMatchObject({
      hint: expect.stringMatching(/fewer columns|aggregate|shorter values/i),
    });
  });

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
    const ctx = createMockContext({ tenantId: 'test', errors: imfDataframeQuery.errors });
    const input = imfDataframeQuery.input.parse({
      canvas_id: 'canvas-abc',
      sql: 'SELECT * FROM spilled_gone',
    });

    const err = await captureMcpError(() => imfDataframeQuery.handler(input, ctx));

    // Distinct from canvas_not_found — the canvas exists, the table does not.
    expect(err.code).toBe(JsonRpcErrorCode.NotFound);
    expect(err.data?.reason).toBe('missing_table');
    expect(err.data?.tableName).toBe('spilled_gone');

    // Nothing the caller reads may name a framework method it cannot call.
    const wire = JSON.stringify({ message: err.message, data: err.data });
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
    const ctx = createMockContext({ tenantId: 'test', errors: imfDataframeQuery.errors });
    const input = imfDataframeQuery.input.parse({
      canvas_id: 'canvas-abc',
      sql: 'SELECT nope FROM spilled_abc123',
    });

    const err = await captureMcpError(() => imfDataframeQuery.handler(input, ctx));

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
    ]) {
      mockCanvasQuery({
        reject: new McpError(
          JsonRpcErrorCode.ValidationError,
          'Canvas query references a system catalog: information_schema.',
          { reason },
        ),
      });
      const ctx = createMockContext({ tenantId: 'test', errors: imfDataframeQuery.errors });
      const input = imfDataframeQuery.input.parse({
        canvas_id: 'canvas-abc',
        sql: 'SELECT * FROM information_schema.tables',
      });

      await expect(imfDataframeQuery.handler(input, ctx)).rejects.toMatchObject({
        code: JsonRpcErrorCode.ValidationError,
        data: {
          reason: 'sql_not_permitted',
          recovery: { hint: expect.stringContaining('imf_dataframe_describe') },
        },
      });
    }
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
