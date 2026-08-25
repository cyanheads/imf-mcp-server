/**
 * @fileoverview Shared test helpers for asserting on thrown McpErrors.
 * @module tests/helpers/errors
 */

import { McpError } from '@cyanheads/mcp-ts-core/errors';

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
