/**
 * @fileoverview The one escape rule for text placed in a GFM table cell the
 * server renders into `content[]`, its clipped form for a cell too long to
 * render whole, and the line-break rule a cell shares with any other one-line
 * rendering of the same text.
 * @module mcp-server/markdown-table
 */

/** `text` with each line break — `\r\n`, `\r`, or `\n` — turned into one space. */
export function lineBreaksAsSpaces(text: string): string {
  return text.replace(/\r\n|\r|\n/g, ' ');
}

/**
 * One GFM table cell holding text the tool did not author, or `—` when the
 * upstream left it null. A `|` would end the cell and a backtick can open a code
 * span across the rest of the row, so both are backslash-escaped, after the
 * backslash itself so an escape in the text cannot swallow the one added here.
 * A line break would end the row, so it becomes a space.
 */
export function tableCell(text: string | null): string {
  if (text == null) return '—';
  return lineBreaksAsSpaces(text.replace(/[\\|`]/g, '\\$&'));
}

const BACKSLASH = 0x5c;
const PIPE = 0x7c;
const BACKTICK = 0x60;
const CR = 0x0d;
const LF = 0x0a;

const isHighSurrogate = (unit: number) => unit >= 0xd800 && unit <= 0xdbff;
const isLowSurrogate = (unit: number) => unit >= 0xdc00 && unit <= 0xdfff;

const clipMarker = (shown: number, total: number) =>
  ` … [clipped: ${shown} of ${total} characters]`;

/** Unicode code points in `text` — the characters SQL `SUBSTR` counts. */
const codePointCount = (text: string) => [...text].length;

/**
 * `tableCell(text)` cut to its longest prefix that, with a trailing
 * `… [clipped: N of M characters]` marker, renders in at most `maxLength`
 * characters. N and M count code points, as SQL `SUBSTR` does, so the unseen rest
 * starts at character N + 1. The cut never splits an escape pair, a CRLF, or a
 * surrogate pair. Below the marker's own length the cell is the marker alone.
 */
export function clipTableCell(text: string, maxLength: number): string {
  const total = codePointCount(text);
  // The marker for `total` is never shorter than the one for any shown count.
  const budget = maxLength - clipMarker(total, total).length;
  let end = 0;
  let rendered = 0;
  let shown = 0;
  while (end < text.length) {
    const unit = text.charCodeAt(end);
    let units = 1;
    let width = 1;
    let points = 1;
    if (unit === CR && text.charCodeAt(end + 1) === LF) {
      units = 2;
      points = 2;
    } else if (isHighSurrogate(unit) && isLowSurrogate(text.charCodeAt(end + 1))) {
      units = 2;
      width = 2;
    } else if (unit === BACKSLASH || unit === PIPE || unit === BACKTICK) {
      width = 2;
    }
    if (rendered + width > budget) break;
    rendered += width;
    end += units;
    shown += points;
  }
  return tableCell(text.slice(0, end)) + clipMarker(shown, total);
}
