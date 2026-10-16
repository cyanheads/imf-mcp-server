/**
 * @fileoverview Tests for the shared GFM table-cell escape.
 * @module tests/markdown-table.test
 */

import { describe, expect, it } from 'vitest';
import { clipTableCell, tableCell } from '@/mcp-server/markdown-table.js';
import { rowCells } from './helpers/markdown-table.js';

const ESCAPES: Array<[input: string, rendered: string]> = [
  ['a|b', 'a\\|b'],
  ['a`b', 'a\\`b'],
  ['end\\', 'end\\\\'],
  ['p\\|q', 'p\\\\\\|q'],
  ['x\ny', 'x y'],
  ['x\r\ny', 'x y'],
  ['x\ry', 'x y'],
];

describe('tableCell', () => {
  it.each(ESCAPES)('renders %j as %j', (input, rendered) => {
    expect(tableCell(input)).toBe(rendered);
  });

  it('renders null as an em dash and leaves plain text and numbers unchanged', () => {
    expect(tableCell(null)).toBe('—');
    expect(tableCell('USA.NGDP_RPCH.A')).toBe('USA.NGDP_RPCH.A');
    expect(tableCell('3.5')).toBe('3.5');
    expect(tableCell('')).toBe('');
  });

  it('keeps every escaped text in one cell that unescapes to the original, line breaks aside', () => {
    const texts = [...ESCAPES.map(([input]) => input), '\\`|\\', '||', '`\n`'];
    for (const text of texts) {
      const cells = rowCells(`| ${tableCell(text)} | next |`);
      expect.soft(cells).toHaveLength(2);
      expect.soft(cells[0]).not.toMatch(/(^|[^\\])(\\\\)*`/);
      expect.soft(cells[0]?.replace(/\\(.)/g, '$1')).toBe(text.replace(/\r\n|\r|\n/g, ' ').trim());
    }
  });

  it('escapes in time linear in the text length', () => {
    /** Thread CPU microseconds spent escaping `text` 20 times, best of three runs. */
    const cpuMicros = (text: string): number => {
      let best = Number.POSITIVE_INFINITY;
      for (let run = 0; run < 3; run++) {
        const start = process.threadCpuUsage();
        for (let i = 0; i < 20; i++) tableCell(text);
        const spent = process.threadCpuUsage(start);
        best = Math.min(best, spent.user + spent.system);
      }
      return best;
    };
    // A digit run never matches either pattern and spans 5k → 320k (64×); the
    // shapes that match on every character span 1k → 64k (64×).
    const shapes: Array<[name: string, make: (n: number) => string, from: number]> = [
      ['digit run', (n) => '7'.repeat(n), 5_000],
      ['pipes', (n) => '|'.repeat(n), 1_000],
      ['backslashes', (n) => '\\'.repeat(n), 1_000],
      ['CRLF pairs', (n) => '\r\n'.repeat(n / 2), 1_000],
      ['mixed', (n) => '|`\\\r\nx'.repeat(n / 6), 1_002],
    ];
    for (const [name, make, from] of shapes) {
      const small = cpuMicros(make(from));
      const large = cpuMicros(make(from * 64));
      expect.soft(large / Math.max(small, 1), name).toBeLessThan(256);
      expect.soft(large, name).toBeLessThan(250_000);
    }
  });
});

/** Shown prefix, shown count, and total count of one clipped cell. */
function parseClip(cell: string): { prefix: string; shown: number; total: number } {
  const match = cell.match(/^(.*) … \[clipped: (\d+) of (\d+) characters\]$/s);
  if (!match) throw new Error(`not a clipped cell: ${cell.slice(-80)}`);
  return { prefix: match[1]!, shown: Number(match[2]), total: Number(match[3]) };
}

/** The first `count` code points of `text`. */
const codePoints = (text: string, count: number) => Array.from(text).slice(0, count).join('');

describe('clipTableCell', () => {
  it('cuts a long cell to its cap and names how much of the text it shows', () => {
    // 50 minus the 35-character marker for 100 of 100 leaves 15 characters of text.
    expect(clipTableCell('abcdefghij'.repeat(10), 50)).toBe(
      'abcdefghijabcde … [clipped: 15 of 100 characters]',
    );
  });

  it('is the marker alone when the cap leaves no room for text', () => {
    expect(clipTableCell('|||', 0)).toBe(' … [clipped: 0 of 3 characters]');
  });

  it('counts characters as code points, the unit SQL SUBSTR takes', () => {
    // 60 minus the 35-character marker leaves 25 UTF-16 units: 12 whole emoji.
    expect(clipTableCell('😀'.repeat(100), 60)).toBe(
      `${'😀'.repeat(12)} … [clipped: 12 of 100 characters]`,
    );
  });

  // Every text below, clipped at every cap from 0 to its whole rendered length,
  // stays one escape-safe cell whose prefix is the longest one that fits.
  const TEXTS = [
    '|'.repeat(40),
    '`a\\b|'.repeat(10),
    '\\'.repeat(41),
    'line\r\nbreak\rand\nmore\r\n'.repeat(4),
    'x😀|'.repeat(12),
    '\ud800lone|surrogate\udc00`',
  ];

  it.each(TEXTS)(
    'never splits an escape pair, CRLF, or surrogate pair, and fills its cap: %j',
    (text) => {
      const whole = tableCell(text);
      const total = Array.from(text).length;
      for (let cap = 0; cap <= whole.length; cap++) {
        const cell = clipTableCell(text, cap);
        const { prefix, shown, total: reported } = parseClip(cell);
        const marker = ` … [clipped: ${total} of ${total} characters]`.length;

        expect.soft(reported).toBe(total);
        if (cap >= marker) expect.soft(cell.length, `cap ${cap}`).toBeLessThanOrEqual(cap);
        // One cell, no code span opened, and the prefix is exactly the escaped start of the text.
        expect.soft(rowCells(`| ${cell} | next |`), `cap ${cap}`).toHaveLength(2);
        expect.soft(prefix, `cap ${cap}`).not.toMatch(/(^|[^\\])(\\\\)*`/);
        expect.soft(prefix, `cap ${cap}`).toBe(tableCell(codePoints(text, shown)));
        // Longest prefix: one more unit (CRLF counts as one) would not fit the cap.
        if (shown < total) {
          const next = text.slice(codePoints(text, shown).length).startsWith('\r\n') ? 2 : 1;
          expect
            .soft(tableCell(codePoints(text, shown + next)).length, `cap ${cap}`)
            .toBeGreaterThan(Math.max(0, cap - marker));
        }
      }
    },
  );

  it('clips in time linear in the text length', () => {
    /** Thread CPU microseconds spent clipping `text` to half its rendered length 20 times, best of three. */
    const cpuMicros = (text: string): number => {
      const cap = Math.floor(tableCell(text).length / 2);
      let best = Number.POSITIVE_INFINITY;
      for (let run = 0; run < 3; run++) {
        const start = process.threadCpuUsage();
        for (let i = 0; i < 20; i++) clipTableCell(text, cap);
        const spent = process.threadCpuUsage(start);
        best = Math.min(best, spent.user + spent.system);
      }
      return best;
    };
    // A digit run spans 5k → 320k (64×); the shapes that escape or pair on every
    // character span 1k → 64k (64×), below the regex slow-mode switch.
    const shapes: Array<[name: string, make: (n: number) => string, from: number]> = [
      ['digit run', (n) => '7'.repeat(n), 5_000],
      ['pipes', (n) => '|'.repeat(n), 1_000],
      ['backslashes', (n) => '\\'.repeat(n), 1_000],
      ['CRLF pairs', (n) => '\r\n'.repeat(n / 2), 1_000],
      ['surrogate pairs', (n) => '😀'.repeat(n / 2), 1_000],
      ['mixed', (n) => '|`\\\r\nx'.repeat(n / 6), 1_002],
    ];
    for (const [name, make, from] of shapes) {
      const small = cpuMicros(make(from));
      const large = cpuMicros(make(from * 64));
      expect.soft(large / Math.max(small, 1), name).toBeLessThan(256);
      expect.soft(large, name).toBeLessThan(250_000);
    }
  });
});
