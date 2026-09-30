/**
 * @fileoverview Shared test helpers for asserting on thrown McpErrors.
 * @module tests/helpers/errors
 */

import { McpError } from '@cyanheads/mcp-ts-core/errors';
import type { runToolContract } from '@cyanheads/mcp-ts-core/testing';

/** The error a `runToolContract` call returned on `structuredContent.error`. */
export interface ContractError {
  code: number;
  data?: Record<string, unknown>;
  message: string;
}

/**
 * The wire error from a `runToolContract` result. Unlike a direct
 * `definition.handler(...)` throw, this envelope carries the declared
 * contract `recovery` the framework fills for a reason thrown without a hint.
 *
 * @throws When the call did not fail.
 */
export function contractError(call: Awaited<ReturnType<typeof runToolContract>>): ContractError {
  const error = (call.structuredContent as { error?: unknown } | undefined)?.error;
  if (!call.isError || !error) {
    throw new Error('expected runToolContract to return an error envelope');
  }
  return error as ContractError;
}

/**
 * Runs a handler call expected to reject and returns the `McpError` it threw.
 *
 * A definition's `handler` is typed `T | Promise<T>`, so `.catch()` is not
 * available on the call itself; awaiting inside the helper keeps the assertion
 * at the call site to a single line.
 *
 * @throws When the call resolves, or rejects with something other than an `McpError`.
 */
export async function captureMcpError(run: () => unknown): Promise<McpError> {
  try {
    await run();
  } catch (err) {
    if (err instanceof McpError) return err;
    throw new Error(`expected an McpError rejection, got: ${String(err)}`);
  }
  throw new Error('expected a rejection, but the call resolved');
}

/**
 * The `recovery.hint` string an `McpError` carries on the wire, or `''` when the
 * error declares no hint. `data` is an untyped record, so the shape is checked
 * rather than asserted.
 */
export function recoveryHint(err: McpError): string {
  const recovery = err.data?.recovery;
  if (typeof recovery === 'object' && recovery !== null && 'hint' in recovery) {
    return String(recovery.hint);
  }
  return '';
}
