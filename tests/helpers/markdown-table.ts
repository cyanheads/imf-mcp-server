/**
 * @fileoverview Shared test helpers for reading rendered GFM table rows,
 * fenced code blocks, and backslash-escaped inline text.
 * @module tests/helpers/markdown-table
 */

/**
 * `text` as a CommonMark renderer shows it once backslash escapes are read
 * (spec §2.4): a backslash before ASCII punctuation drops and leaves the
 * punctuation literal; before anything else it stays. Error and trailer text in
 * `content[]` escapes caller-visible punctuation this way.
 */
export function unescapeMarkdown(text: string): string {
  return text.replace(/\\([!-/:-@[-`{-~])/g, '$1');
}

/**
 * The first backtick-fenced code block in `text`, read by the CommonMark rules
 * (spec §4.5) a markdown renderer applies: an opening fence is up to three spaces
 * of indentation and a run of three or more backticks followed by an info string
 * holding no backtick; the block's content runs until a line that is up to three
 * spaces, a backtick run at least as long as the opening one, and only spaces or
 * tabs after it, or until the end of the document. Lines end at `\n`, `\r\n`, or `\r`.
 */
export function fencedCodeBlock(text: string): {
  fence: string;
  lines: string[];
  closed: boolean;
} {
  const all = text.split(/\r\n|\r|\n/);
  const open = all.findIndex((line) => /^ {0,3}`{3,}[^`]*$/.test(line));
  if (open === -1) throw new Error('No backtick-fenced code block in the text');
  const fence = /`+/.exec(all[open]!)![0];
  const closes = (line: string) => {
    const run = /^ {0,3}(`+)[ \t]*$/.exec(line);
    return run !== null && run[1]!.length >= fence.length;
  };
  const close = all.findIndex((line, index) => index > open && closes(line));
  return {
    fence,
    lines: all.slice(open + 1, close === -1 ? undefined : close),
    closed: close !== -1,
  };
}

/**
 * GFM cells of one rendered table row. A backslash escapes the character after
 * it, so only an unescaped `|` divides cells — the rule a markdown renderer applies.
 */
export function rowCells(row: string): string[] {
  const cells: string[] = [];
  let cell = '';
  for (let i = 0; i < row.length; i++) {
    const ch = row[i];
    if (ch === '\\' && i + 1 < row.length) {
      cell += ch + row[i + 1];
      i++;
    } else if (ch === '|') {
      cells.push(cell.trim());
      cell = '';
    } else {
      cell += ch;
    }
  }
  cells.push(cell.trim());
  return cells.slice(1, -1);
}
