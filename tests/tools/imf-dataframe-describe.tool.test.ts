/**
 * @fileoverview Tests for the imf_dataframe_describe tool.
 * @module tests/tools/imf-dataframe-describe.tool.test
 */

import { z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/services/canvas/canvas-accessor.js', () => ({
  getCanvas: vi.fn(),
}));

import { imfDataframeDescribe } from '@/mcp-server/tools/definitions/imf-dataframe-describe.tool.js';
import { getCanvas } from '@/services/canvas/canvas-accessor.js';

/**
 * A canvas id the registry does not hold, in the shape `CanvasIdSchema`
 * advertises — 10 characters from `[A-Za-z0-9_-]`. It has to be well-formed:
 * a malformed id is rejected at argument validation and never reaches the
 * handler, so a badly-shaped literal here would test the schema, not the miss.
 */
const EXPIRED_CANVAS_ID = 'cv0expired';

const MOCK_TABLE_INFOS = [
  {
    name: 'spilled_abc123',
    rowCount: 1000,
    columns: [
      { name: 'time_period', type: 'VARCHAR' },
      { name: 'value', type: 'DOUBLE' },
      { name: 'status', type: 'VARCHAR' },
    ],
  },
];

describe('imfDataframeDescribe', () => {
  beforeEach(() => {
    (getCanvas as ReturnType<typeof vi.fn>).mockReturnValue(undefined);
  });

  it('throws ctx.fail("canvas_not_found") when canvas is disabled', async () => {
    (getCanvas as ReturnType<typeof vi.fn>).mockReturnValue(undefined);
    const ctx = createMockContext({ tenantId: 'test', errors: imfDataframeDescribe.errors });
    const input = imfDataframeDescribe.input.parse({ canvas_id: 'canvas-abc' });

    await expect(imfDataframeDescribe.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'canvas_not_found' },
    });
  });

  it('throws ctx.fail("canvas_not_found") when canvas.acquire fails', async () => {
    const mockCanvasSvc = { acquire: vi.fn().mockRejectedValue(new Error('not found')) };
    (getCanvas as ReturnType<typeof vi.fn>).mockReturnValue(mockCanvasSvc);
    const ctx = createMockContext({ tenantId: 'test', errors: imfDataframeDescribe.errors });
    const input = imfDataframeDescribe.input.parse({ canvas_id: EXPIRED_CANVAS_ID });

    await expect(imfDataframeDescribe.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'canvas_not_found' },
    });
  });

  it('returns table schema for a valid canvas', async () => {
    const mockInstance = {
      canvasId: 'canvas-abc',
      describe: vi.fn().mockResolvedValue(MOCK_TABLE_INFOS),
    };
    (getCanvas as ReturnType<typeof vi.fn>).mockReturnValue({
      acquire: vi.fn().mockResolvedValue(mockInstance),
    });

    const ctx = createMockContext({ tenantId: 'test', errors: imfDataframeDescribe.errors });
    const input = imfDataframeDescribe.input.parse({ canvas_id: 'canvas-abc' });
    const result = await imfDataframeDescribe.handler(input, ctx);

    expect(result.canvas_id).toBe('canvas-abc');
    expect(result.table_count).toBe(1);
    expect(result.tables[0]!.name).toBe('spilled_abc123');
    expect(result.tables[0]!.row_count).toBe(1000);
    expect(result.tables[0]!.columns).toHaveLength(3);
    expect(result.tables[0]!.columns[0]).toEqual({ name: 'time_period', type: 'VARCHAR' });
  });

  it('formats table schema as markdown', () => {
    const output = {
      canvas_id: 'canvas-abc',
      table_count: 1,
      tables: [
        {
          name: 'spilled_abc123',
          row_count: 1000,
          columns: [
            { name: 'time_period', type: 'VARCHAR' },
            { name: 'value', type: 'DOUBLE' },
          ],
        },
      ],
    };
    const blocks = imfDataframeDescribe.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('canvas-abc');
    expect(text).toContain('spilled_abc123');
    expect(text).toContain('1000');
    expect(text).toContain('time_period');
    expect(text).toContain('VARCHAR');
    expect(text).toContain('DOUBLE');
  });

  // -------------------------------------------------------------------------
  // #9: canvas_not_found recovery text
  // -------------------------------------------------------------------------

  it('canvas_not_found recovery tells caller to re-run imf_query_dataset', async () => {
    (getCanvas as ReturnType<typeof vi.fn>).mockReturnValue(undefined);
    const ctx = createMockContext({ tenantId: 'test', errors: imfDataframeDescribe.errors });
    const input = imfDataframeDescribe.input.parse({ canvas_id: 'canvas-abc' });

    try {
      await imfDataframeDescribe.handler(input, ctx);
    } catch {
      // The throw is expected; this test asserts on the declared recovery text.
    }
    // Recovery should mention re-running imf_query_dataset, not CANVAS_PROVIDER_TYPE
    const recovery =
      imfDataframeDescribe.errors?.find((e) => e.reason === 'canvas_not_found')?.recovery ?? '';
    expect(recovery).toContain('imf_query_dataset');
    expect(recovery).not.toContain('CANVAS_PROVIDER_TYPE');
  });

  // -------------------------------------------------------------------------
  // canvas_id carries the minted CanvasIdSchema shape in inputSchema
  // -------------------------------------------------------------------------

  describe('canvas_id shape', () => {
    /** Every rejected form and why the schema refuses it. */
    const MALFORMED = [
      ['too short', 'cv0expire'],
      ['too long', 'expired-canvas'],
      ['character outside the minted set', 'cv0expire!'],
      ['empty', ''],
    ] as const;

    it.each(MALFORMED)('rejects a %s canvas_id before the handler runs', async (_label, id) => {
      const acquire = vi.fn();
      (getCanvas as ReturnType<typeof vi.fn>).mockReturnValue({ acquire });

      const result = await runToolContract(imfDataframeDescribe, { canvas_id: id });
      const error = (
        result.structuredContent as { error: { code: number; data?: { reason?: string } } }
      ).error;

      // Argument validation, not the tool's own canvas_not_found — the handler
      // never runs, so the canvas is never touched.
      expect(error.code).toBe(JsonRpcErrorCode.InvalidParams);
      expect(error.data?.reason).toBe('invalid_arguments');
      expect(acquire).not.toHaveBeenCalled();

      // Both consumption paths carry the rejection: structuredContent above,
      // content[] here. The framework appends its own recovery and reason
      // trailers, so assert containment rather than the exact text.
      const text = (result.content[0] as { text: string }).text;
      expect(text).toContain('canvas_id');
    });

    it('accepts a well-formed canvas_id and reaches the handler', async () => {
      const describeTables = vi.fn().mockResolvedValue(MOCK_TABLE_INFOS);
      (getCanvas as ReturnType<typeof vi.fn>).mockReturnValue({
        acquire: vi
          .fn()
          .mockResolvedValue({ canvasId: EXPIRED_CANVAS_ID, describe: describeTables }),
      });

      const result = await runToolContract(imfDataframeDescribe, {
        canvas_id: EXPIRED_CANVAS_ID,
      });

      expect(describeTables).toHaveBeenCalledOnce();
      expect(result.structuredContent).toMatchObject({
        canvas_id: EXPIRED_CANVAS_ID,
        table_count: 1,
      });
      expect((result.content[0] as { text: string }).text).toContain('spilled_abc123');
    });

    it('advertises the minted shape in the JSON Schema a client reads', () => {
      const { properties } = z.toJSONSchema(imfDataframeDescribe.input, { io: 'input' });

      expect(properties?.canvas_id).toMatchObject({
        // The constraint has to reach the wire, not just the handler — that is
        // the whole point of declaring the field with CanvasIdSchema.
        pattern: '^[A-Za-z0-9_-]{10}$',
        // The pattern alone says nothing about where an id comes from.
        description: expect.stringContaining('imf_query_dataset'),
      });
    });
  });
});
