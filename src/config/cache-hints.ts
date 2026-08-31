/**
 * @fileoverview Public cache policy for stable MCP metadata responses.
 * @module config/cache-hints
 */

import type { CacheHints } from '@cyanheads/mcp-ts-core';

const METADATA_CACHE_HINT = { ttlMs: 3_600_000, cacheScope: 'public' } as const;

/** Cache hints emitted only on protocol revision 2026-07-28. */
export const IMF_METADATA_CACHE_HINTS = {
  'tools/list': METADATA_CACHE_HINT,
  'prompts/list': METADATA_CACHE_HINT,
  'resources/list': METADATA_CACHE_HINT,
  'resources/templates/list': METADATA_CACHE_HINT,
  'resources/read': METADATA_CACHE_HINT,
  'server/discover': METADATA_CACHE_HINT,
} satisfies CacheHints;
