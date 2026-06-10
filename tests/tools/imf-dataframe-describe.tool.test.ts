/**
 * @fileoverview Tests for the imf_dataframe_describe tool.
 * @module tests/tools/imf-dataframe-describe.tool.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/services/canvas/canvas-accessor.js', () => ({
  getCanvas: vi.fn(),
}));

import { imfDataframeDescribe } from '@/mcp-server/tools/definitions/imf-dataframe-describe.tool.js';
import { getCanvas } from '@/services/canvas/canvas-accessor.js';

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
    const input = imfDataframeDescribe.input.parse({ canvas_id: 'expired-canvas' });

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
    expect(result.tables[0].name).toBe('spilled_abc123');
    expect(result.tables[0].row_count).toBe(1000);
    expect(result.tables[0].columns).toHaveLength(3);
    expect(result.tables[0].columns[0]).toEqual({ name: 'time_period', type: 'VARCHAR' });
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

    await imfDataframeDescribe.handler(input, ctx).catch(() => {});
    // Recovery should mention re-running imf_query_dataset, not CANVAS_PROVIDER_TYPE
    const recovery =
      imfDataframeDescribe.errors?.find((e) => e.reason === 'canvas_not_found')?.recovery ?? '';
    expect(recovery).toContain('imf_query_dataset');
    expect(recovery).not.toContain('CANVAS_PROVIDER_TYPE');
  });
});
