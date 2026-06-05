/**
 * @fileoverview Tests for the imf_dataframe_query tool.
 * @module tests/tools/imf-dataframe-query.tool.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/services/canvas/canvas-accessor.js', () => ({
  getCanvas: vi.fn(),
}));

import { imfDataframeQuery } from '@/mcp-server/tools/definitions/imf-dataframe-query.tool.js';
import { getCanvas } from '@/services/canvas/canvas-accessor.js';

const MOCK_ROWS = [
  { time_period: '2020', value: 3.5, status: null },
  { time_period: '2021', value: 5.1, status: 'E' },
];

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

  it('throws ValidationError when SQL is not a SELECT statement', async () => {
    // Canvas is disabled — but the SQL check happens before the canvas check
    // Actually the handler checks canvas first, then SQL. Let's enable canvas:
    const mockInstance = { canvasId: 'canvas-abc', query: vi.fn() };
    (getCanvas as ReturnType<typeof vi.fn>).mockReturnValue({
      acquire: vi.fn().mockResolvedValue(mockInstance),
    });

    const ctx = createMockContext({ tenantId: 'test', errors: imfDataframeQuery.errors });
    const input = imfDataframeQuery.input.parse({
      canvas_id: 'canvas-abc',
      sql: 'DROP TABLE spilled_abc123',
    });

    await expect(imfDataframeQuery.handler(input, ctx)).rejects.toThrow(/SELECT/);
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
    };
    const blocks = imfDataframeQuery.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('2020');
    expect(text).toContain('3.5');
    expect(text).toContain('time_period');
    expect(text).toContain('value');
  });

  it('formats empty result set', () => {
    const output = { rows: [], row_count: 0 };
    const blocks = imfDataframeQuery.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('0');
  });
});
