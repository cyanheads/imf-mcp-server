/**
 * @fileoverview Shared bounded projection for IMF dimension codelists, and the
 * every-word text matcher behind both `codelist_filter` and the dataflow
 * catalog's `filter`.
 * @module mcp-server/codelist-page
 */

import type { CodelistEntry } from '@/services/imf-sdmx/types.js';

/** Default number of codelist entries returned per dimension or selected page. */
export const CODELIST_PREVIEW_LIMIT = 50;

/** Largest selected-dimension codelist page a caller may request. */
export const MAX_CODELIST_PAGE_LIMIT = 200;

export interface CodelistPage {
  codelist: CodelistEntry[];
  codelist_truncated: boolean;
  matched_count: number;
  next_offset?: number;
  offset: number;
  returned_count: number;
  unfiltered_count: number;
}

/**
 * Build a case-insensitive predicate over an entry's searchable fields for one
 * filter. The filter splits on whitespace and commas, and an entry matches when
 * every token appears in at least one field — different tokens may match
 * different fields, and every other character stays literal inside its token
 * (`St.` keeps its dot). A filter made only of separators matches as one literal
 * substring, and a filter with no separator is one token, a plain substring
 * match. A field holding the whole filter literally holds every token too, so
 * splitting never loses a literal match.
 */
export function createFilterMatcher(
  filter: string,
): (fields: readonly (string | undefined)[]) => boolean {
  const filterLower = filter.toLowerCase();
  const words = filterLower.split(/[\s,]+/).filter(Boolean);
  const tokens = words.length > 0 ? words : [filterLower];
  return (fields) => {
    const haystacks = fields.flatMap((field) => (field ? [field.toLowerCase()] : []));
    return tokens.every((token) => haystacks.some((haystack) => haystack.includes(token)));
  };
}

/** Filter, then slice, one complete in-memory codelist without another upstream request. */
export function projectCodelist(
  entries: readonly CodelistEntry[],
  options: { filter?: string; limit?: number; offset?: number } = {},
): CodelistPage {
  const offset = options.offset ?? 0;
  const limit = options.limit ?? CODELIST_PREVIEW_LIMIT;
  const matchesFilter = options.filter ? createFilterMatcher(options.filter) : undefined;
  const matches = matchesFilter
    ? entries.filter((entry) => matchesFilter([entry.id, entry.name]))
    : [...entries];
  const codelist = matches.slice(offset, offset + limit);
  const nextOffset = offset + codelist.length;

  return {
    codelist,
    codelist_truncated: codelist.length < matches.length,
    matched_count: matches.length,
    ...(nextOffset < matches.length ? { next_offset: nextOffset } : {}),
    offset,
    returned_count: codelist.length,
    unfiltered_count: entries.length,
  };
}
