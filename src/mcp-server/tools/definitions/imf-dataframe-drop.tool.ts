/**
 * @fileoverview Tool: imf_dataframe_drop — remove one table or view from a DataCanvas.
 * @module mcp-server/tools/definitions/imf-dataframe-drop.tool
 */

import { disabledTool, tool, z } from '@cyanheads/mcp-ts-core';
import { CanvasIdSchema } from '@cyanheads/mcp-ts-core/canvas';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { getServerConfig } from '@/config/server-config.js';
import { getCanvas } from '@/services/canvas/canvas-accessor.js';

const INVALID_IDENTIFIER_REASONS = new Set([
  'identifier_empty',
  'identifier_shape',
  'identifier_reserved',
]);

const imfDataframeDropDefinition = tool('imf_dataframe_drop', {
  description:
    'Remove one DataCanvas table or view staged by imf_query_dataset without affecting other tables on the same canvas. ' +
    'Use imf_dataframe_describe to copy the exact table name. A repeated or absent drop returns dropped=false.',
  annotations: {
    readOnlyHint: false,
    idempotentHint: true,
    destructiveHint: true,
    openWorldHint: false,
  },
  input: z.object({
    canvas_id: CanvasIdSchema.describe(
      'Canvas ID returned by imf_query_dataset whenever staged=true.',
    ),
    table_name: z.string().describe('Exact table or view name returned by imf_dataframe_describe.'),
  }),
  output: z.object({
    canvas_id: z.string().describe('Canvas session ID on which the drop was attempted.'),
    table_name: z.string().describe('Requested table or view name.'),
    dropped: z
      .boolean()
      .describe(
        'True when the named table or view was removed; false when it was not staged at call time.',
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
      reason: 'invalid_table_name',
      code: JsonRpcErrorCode.ValidationError,
      when: 'table_name is empty, malformed, longer than 63 characters, or a reserved SQL keyword',
      severity: 'warning',
      recovery: 'Copy an exact table name from imf_dataframe_describe and try again.',
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
    } catch (error: unknown) {
      if (error instanceof McpError && error.data?.reason !== 'canvas_not_found') {
        throw error;
      }
      throw ctx.fail('canvas_not_found', `Canvas '${input.canvas_id}' not found or expired`, {
        canvasId: input.canvas_id,
        ...ctx.recoveryFor('canvas_not_found'),
      });
    }

    let dropped: boolean;
    try {
      dropped = await instance.drop(input.table_name);
    } catch (error: unknown) {
      if (!(error instanceof McpError)) throw error;
      const reason = error.data?.reason;
      if (reason === 'canvas_not_found') {
        throw ctx.fail('canvas_not_found', `Canvas '${input.canvas_id}' not found or expired`, {
          canvasId: input.canvas_id,
          ...ctx.recoveryFor('canvas_not_found'),
        });
      }
      if (typeof reason !== 'string' || !INVALID_IDENTIFIER_REASONS.has(reason)) throw error;
      throw ctx.fail('invalid_table_name', error.message, {
        tableName: input.table_name,
        ...ctx.recoveryFor('invalid_table_name'),
      });
    }

    ctx.log.info('Canvas table drop attempted', {
      canvasId: instance.canvasId,
      tableName: input.table_name,
      dropped,
    });

    return { canvas_id: instance.canvasId, table_name: input.table_name, dropped };
  },

  format: (result) => [
    {
      type: 'text',
      text:
        `**Canvas:** \`${result.canvas_id}\`\n**Table:** \`${result.table_name}\`\n**Dropped:** ${result.dropped}\n\n` +
        (result.dropped
          ? 'The staged table or view was removed.'
          : 'No staged table or view matched the requested name.'),
    },
  ],
});

export const imfDataframeDrop = getServerConfig().enableDataframeDrop
  ? imfDataframeDropDefinition
  : disabledTool(imfDataframeDropDefinition, {
      reason: 'Dataframe table cleanup is disabled in this deployment.',
      hint: 'IMF_ENABLE_DATAFRAME_DROP=true',
    });
