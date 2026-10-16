/**
 * @fileoverview Schema wrappers that read a blank optional tool input as unset.
 * Form-based clients send every optional field they display as `""`, so a blank
 * or whitespace-only value is mapped to `undefined` before the field's own
 * validator and default run. The advertised schema is unchanged:
 * `toJSONSchema` emits only the inner schema of a preprocess pipe.
 * @module mcp-server/optional-input
 */

import { z } from '@cyanheads/mcp-ts-core';

/** What a string input may spell besides itself. */
type Spelling = 'number' | 'boolean';

/**
 * A blank string becomes `undefined`. A string spelling a number or boolean
 * becomes that value when the field takes one: the framework's own repair of
 * `"15"` → `15` does not reach a field routed through `z.preprocess()`, so it is
 * reproduced here with the same rule — a number only when `String(n)` gives the
 * trimmed string back (`"15"`, `" 15 "`; never `"01"` or `"1e3"`), a boolean only
 * from `"true"` or `"false"`. Anything else passes through to the validator.
 */
function readBlankAsUnset(value: unknown, spelling?: Spelling): unknown {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (trimmed === '') return;
  if (spelling === 'number') {
    const number = Number(trimmed);
    if (Number.isFinite(number) && String(number) === trimmed) return number;
  }
  if (spelling === 'boolean' && (trimmed === 'true' || trimmed === 'false')) {
    return trimmed === 'true';
  }
  return value;
}

/** An optional string input whose blank or whitespace-only value is unset, never a value to validate. */
export const blankAsUnset = <T extends z.ZodType>(schema: T) =>
  z.preprocess((value) => readBlankAsUnset(value), schema);

/** An optional numeric input: blank is unset, and a string spelling a number is that number. */
export const blankAsUnsetNumber = <T extends z.ZodType>(schema: T) =>
  z.preprocess((value) => readBlankAsUnset(value, 'number'), schema);

/** An optional boolean input: blank is unset, and `"true"`/`"false"` are the booleans they spell. */
export const blankAsUnsetBoolean = <T extends z.ZodType>(schema: T) =>
  z.preprocess((value) => readBlankAsUnset(value, 'boolean'), schema);
