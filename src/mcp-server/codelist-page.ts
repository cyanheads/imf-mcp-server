/**
 * @fileoverview Shared bounded projection for IMF dimension codelists.
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

/** Filter, then slice, one complete in-memory codelist without another upstream request. */
export function projectCodelist(
  entries: readonly CodelistEntry[],
  options: { filter?: string; limit?: number; offset?: number } = {},
): CodelistPage {
  const offset = options.offset ?? 0;
  const limit = options.limit ?? CODELIST_PREVIEW_LIMIT;
  const filterLower = options.filter?.toLowerCase();
  const matches = filterLower
    ? entries.filter(
        (entry) =>
          entry.id.toLowerCase().includes(filterLower) ||
          entry.name.toLowerCase().includes(filterLower),
      )
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
