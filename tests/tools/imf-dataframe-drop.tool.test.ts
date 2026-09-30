/**
 * @fileoverview Tests for the imf_dataframe_drop tool.
 * @module tests/tools/imf-dataframe-drop.tool.test
 */

import {
  type CanvasInstance,
  CanvasRegistry,
  DataCanvas,
  DuckdbProvider,
} from '@cyanheads/mcp-ts-core/canvas';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { contractError } from '../helpers/errors.js';

vi.mock('@/services/canvas/canvas-accessor.js', () => ({
  getCanvas: vi.fn(),
}));

import { imfDataframeDrop } from '@/mcp-server/tools/definitions/imf-dataframe-drop.tool.js';
import { getCanvas } from '@/services/canvas/canvas-accessor.js';

let canvas: DataCanvas;
let instance: CanvasInstance;
let ctx: Parameters<typeof imfDataframeDrop.handler>[1];

async function createRealCanvas(): Promise<void> {
  const provider = new DuckdbProvider({
    defaultRowLimit: 10_000,
    exportRootPath: '.canvas-exports',
    memoryLimitMb: 128,
    schemaSniffRows: 100,
  });
  const registry = new CanvasRegistry(provider, {
    absoluteCapMs: 60_000,
    maxCanvasesPerTenant: 10,
    sweeperIntervalMs: 0,
    ttlMs: 60_000,
  });
  canvas = new DataCanvas(provider, registry);
  ctx = createMockContext({ tenantId: 'test', errors: imfDataframeDrop.errors });
  instance = await canvas.acquire(undefined, ctx);
  (getCanvas as ReturnType<typeof vi.fn>).mockReturnValue(canvas);
}

describe('imfDataframeDrop', () => {
  beforeEach(async () => {
    await createRealCanvas();
  });

  afterEach(async () => {
    await canvas.shutdown(ctx);
  });

  it('drops one table, preserves unrelated tables, and emits both output channels', async () => {
    await instance.registerTable('target_table', [{ value: 1 }]);
    await instance.registerTable('keep_table', [{ value: 2 }]);

    const call = await runToolContract(
      imfDataframeDrop,
      { canvas_id: instance.canvasId, table_name: 'target_table' },
      { context: { tenantId: 'test' } },
    );

    expect(call.structuredContent).toEqual({
      canvas_id: instance.canvasId,
      table_name: 'target_table',
      dropped: true,
    });
    expect(JSON.stringify(call.content)).toContain(instance.canvasId);
    expect(JSON.stringify(call.content)).toContain('target_table');
    expect(JSON.stringify(call.content)).toContain('true');
    expect((await instance.describe()).map((table) => table.name)).toEqual(['keep_table']);
  });

  it('leaves the canvas valid and empty after dropping its only table', async () => {
    await instance.registerTable('only_table', [{ value: 1 }]);

    const result = await imfDataframeDrop.handler(
      imfDataframeDrop.input.parse({
        canvas_id: instance.canvasId,
        table_name: 'only_table',
      }),
      ctx,
    );

    expect(result.dropped).toBe(true);
    expect(await instance.describe()).toEqual([]);
    await expect(canvas.acquire(instance.canvasId, ctx)).resolves.toMatchObject({
      canvasId: instance.canvasId,
    });
  });

  it('returns dropped=false for absent and repeated drops', async () => {
    await instance.registerTable('repeat_table', [{ value: 1 }]);
    const input = imfDataframeDrop.input.parse({
      canvas_id: instance.canvasId,
      table_name: 'repeat_table',
    });

    await expect(imfDataframeDrop.handler(input, ctx)).resolves.toMatchObject({ dropped: true });
    await expect(imfDataframeDrop.handler(input, ctx)).resolves.toEqual({
      canvas_id: instance.canvasId,
      table_name: 'repeat_table',
      dropped: false,
    });

    const absent = imfDataframeDrop.input.parse({
      canvas_id: instance.canvasId,
      table_name: 'never_staged',
    });
    const result = await imfDataframeDrop.handler(absent, ctx);
    const text = (imfDataframeDrop.format!(result)[0] as { text: string }).text;
    expect(result.dropped).toBe(false);
    expect(text).toContain('false');
    expect(text).not.toMatch(/removed|deleted/i);
  });

  it.each(['', 'bad-name', 'select'])(
    'maps invalid table identifier %j to invalid_table_name',
    async (tableName) => {
      const call = await runToolContract(
        imfDataframeDrop,
        { canvas_id: instance.canvasId, table_name: tableName },
        { context: { tenantId: 'test' } },
      );

      expect(contractError(call)).toMatchObject({
        code: JsonRpcErrorCode.ValidationError,
        data: {
          reason: 'invalid_table_name',
          recovery: { hint: expect.stringContaining('imf_dataframe_describe') },
        },
      });
    },
  );

  it('maps unknown, expired, wrong-tenant, and disabled canvases to canvas_not_found', async () => {
    const input = imfDataframeDrop.input.parse({
      canvas_id: instance.canvasId,
      table_name: 'target_table',
    });

    const wrongTenantCtx = createMockContext({
      tenantId: 'other',
      errors: imfDataframeDrop.errors,
    });
    await expect(imfDataframeDrop.handler(input, wrongTenantCtx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'canvas_not_found' },
    });

    const unknown = imfDataframeDrop.input.parse({
      canvas_id: 'unknown-id',
      table_name: 'target_table',
    });
    await expect(imfDataframeDrop.handler(unknown, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'canvas_not_found' },
    });

    (getCanvas as ReturnType<typeof vi.fn>).mockReturnValue({
      acquire: vi.fn().mockRejectedValue(new Error('expired')),
    });
    await expect(imfDataframeDrop.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'canvas_not_found' },
    });

    (getCanvas as ReturnType<typeof vi.fn>).mockReturnValue(undefined);
    await expect(imfDataframeDrop.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'canvas_not_found' },
    });
  });

  it('does not mask an unrelated McpError raised while acquiring the canvas', async () => {
    const upstream = new McpError(JsonRpcErrorCode.DatabaseError, 'Canvas registry failed.');
    (getCanvas as ReturnType<typeof vi.fn>).mockReturnValue({
      acquire: vi.fn().mockRejectedValue(upstream),
    });
    const input = imfDataframeDrop.input.parse({
      canvas_id: instance.canvasId,
      table_name: 'target_table',
    });

    await expect(imfDataframeDrop.handler(input, ctx)).rejects.toBe(upstream);
  });

  it('does not infer canvas_not_found from an undeclared NotFound McpError', async () => {
    const upstream = new McpError(JsonRpcErrorCode.NotFound, 'Unknown registry lookup failure.');
    (getCanvas as ReturnType<typeof vi.fn>).mockReturnValue({
      acquire: vi.fn().mockRejectedValue(upstream),
    });
    const input = imfDataframeDrop.input.parse({
      canvas_id: instance.canvasId,
      table_name: 'target_table',
    });

    await expect(imfDataframeDrop.handler(input, ctx)).rejects.toBe(upstream);
  });

  it('maps a canvas that expires during drop to the local canvas_not_found recovery', async () => {
    const expired = new McpError(JsonRpcErrorCode.NotFound, 'Canvas expired.', {
      reason: 'canvas_not_found',
      recovery: { hint: 'Internal canvas recovery.' },
    });
    (getCanvas as ReturnType<typeof vi.fn>).mockReturnValue({
      acquire: vi.fn().mockResolvedValue({
        canvasId: instance.canvasId,
        drop: vi.fn().mockRejectedValue(expired),
      }),
    });
    const call = await runToolContract(
      imfDataframeDrop,
      { canvas_id: instance.canvasId, table_name: 'target_table' },
      { context: { tenantId: 'test' } },
    );

    expect(contractError(call)).toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: {
        reason: 'canvas_not_found',
        recovery: { hint: expect.stringContaining('imf_query_dataset') },
      },
    });
  });

  it('declares the mutating idempotent annotations and recovery contracts', () => {
    expect(imfDataframeDrop.annotations).toEqual({
      readOnlyHint: false,
      idempotentHint: true,
      destructiveHint: true,
      openWorldHint: false,
    });
    expect(imfDataframeDrop.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          reason: 'canvas_not_found',
          code: JsonRpcErrorCode.NotFound,
          recovery: expect.stringContaining('imf_query_dataset'),
        }),
        expect.objectContaining({
          reason: 'invalid_table_name',
          code: JsonRpcErrorCode.ValidationError,
          recovery: expect.stringContaining('imf_dataframe_describe'),
        }),
      ]),
    );
  });
});
