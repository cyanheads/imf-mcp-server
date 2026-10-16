/**
 * @fileoverview Tests for the blank-as-unset schema wrappers (#67): a blank or
 * whitespace-only value parses as if the field were omitted, a numeric or
 * boolean field keeps the framework's string-spelling repair that a preprocess
 * would otherwise switch off, and the advertised JSON Schema is the inner
 * schema's, byte for byte.
 * @module tests/mcp-server/optional-input.test
 */

import { z } from '@cyanheads/mcp-ts-core';
import { CanvasIdSchema } from '@cyanheads/mcp-ts-core/canvas';
import { describe, expect, it } from 'vitest';
import {
  blankAsUnset,
  blankAsUnsetBoolean,
  blankAsUnsetNumber,
} from '@/mcp-server/optional-input.js';

const BLANKS = ['', ' ', '   ', '\t\n '];

describe('blankAsUnset', () => {
  const filter = blankAsUnset(z.string().trim().min(1).optional());

  it.each(BLANKS)('reads %j as unset', (blank) => {
    expect(filter.parse(blank)).toBeUndefined();
  });

  it('passes a non-blank value to the inner validator unchanged', () => {
    expect(filter.parse('  GDP  ')).toBe('GDP');
    // A numeric spelling stays a string on a string field.
    expect(blankAsUnset(z.string().optional()).parse('9')).toBe('9');
    expect(blankAsUnset(CanvasIdSchema.optional()).safeParse('not a canvas id').success).toBe(
      false,
    );
  });

  it('lets an inner default apply to a blank', () => {
    expect(blankAsUnset(z.enum(['auto', 'canvas']).default('auto')).parse('  ')).toBe('auto');
  });
});

describe('blankAsUnsetNumber', () => {
  const limit = blankAsUnsetNumber(z.number().int().min(1).max(1_000).default(50));

  it.each(BLANKS)('reads %j as unset, so the default applies', (blank) => {
    expect(limit.parse(blank)).toBe(50);
  });

  it.each([
    ['3', 3],
    [' 250 ', 250],
    ['1000', 1_000],
  ])('turns %j into the number it spells', (sent, parsed) => {
    expect(limit.parse(sent)).toBe(parsed);
  });

  it.each([
    ['01', 'invalid_type'],
    ['1e3', 'invalid_type'],
    ['1.50', 'invalid_type'],
    ['0x10', 'invalid_type'],
    ['-0', 'invalid_type'],
    ['ten', 'invalid_type'],
    ['2.5', 'invalid_type'],
    ['0', 'too_small'],
    ['-1', 'too_small'],
    ['1001', 'too_big'],
  ])('rejects %j as %s', (sent, code) => {
    const result = limit.safeParse(sent);
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.code).toBe(code);
  });
});

describe('blankAsUnsetBoolean', () => {
  const flag = blankAsUnsetBoolean(z.boolean().default(false));

  it.each(BLANKS)('reads %j as unset, so the default applies', (blank) => {
    expect(flag.parse(blank)).toBe(false);
  });

  it('turns "true" and "false" into the booleans they spell, and nothing else', () => {
    expect(flag.parse('true')).toBe(true);
    expect(flag.parse(' false ')).toBe(false);
    expect(flag.safeParse('yes').success).toBe(false);
    expect(flag.safeParse('1').success).toBe(false);
  });
});

describe('advertised schema', () => {
  it.each([
    ['a trimmed, non-empty string', z.string().trim().min(1).optional()],
    ['a canvas id pattern', CanvasIdSchema.optional()],
    ['an enum with a default', z.enum(['auto', 'canvas']).default('auto')],
  ])('is unchanged for %s', (_label, inner) => {
    expect(z.toJSONSchema(blankAsUnset(inner))).toEqual(z.toJSONSchema(inner));
  });

  it('is unchanged for a bounded integer with a default', () => {
    const inner = z.number().int().min(1).max(1_000).default(50);
    expect(z.toJSONSchema(blankAsUnsetNumber(inner))).toEqual(z.toJSONSchema(inner));
  });

  it('is unchanged for a boolean with a default', () => {
    const inner = z.boolean().default(false);
    expect(z.toJSONSchema(blankAsUnsetBoolean(inner))).toEqual(z.toJSONSchema(inner));
  });
});
