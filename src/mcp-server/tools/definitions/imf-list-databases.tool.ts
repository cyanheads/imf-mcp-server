/**
 * @fileoverview Tool: imf_list_databases — list IMF SDMX dataflows available on the portal,
 * one page at a time. The catalog is a discovery surface, so entries carry a
 * short description and the page is bounded by limit/offset; the full text of a
 * description lives on imf_get_database and the imf://database/{dataflow_id}
 * resource, for the one dataflow a caller picks.
 * @module mcp-server/tools/definitions/imf-list-databases.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getImfSdmxService } from '@/services/imf-sdmx/imf-sdmx-service.js';

const VINTAGE_PATTERN = /VINTAGE/i;

/** Default page size — the whole catalog is 103 non-vintage dataflows, 222 with vintages. */
const DEFAULT_LIMIT = 50;

/** Largest page a caller may ask for — one call still reaches every non-vintage dataflow. */
const MAX_LIMIT = 200;

/**
 * Longest description this listing carries per dataflow. Descriptions run to a
 * median of ~340 characters and a maximum past 1,500, which made an unfiltered
 * catalog cost more than the query it exists to set up. The cut is safe because
 * the untruncated text stays searchable through `filter` and is returned in full
 * by imf_get_database for the dataflow the caller settles on.
 */
const DESCRIPTION_PREVIEW_CHARS = 200;

/** Cut a description to the preview length, marking it so a reader knows text follows. */
function previewDescription(description: string): string {
  if (description.length <= DESCRIPTION_PREVIEW_CHARS) return description;
  return `${description.slice(0, DESCRIPTION_PREVIEW_CHARS).trimEnd()}…`;
}

export const imfListDatabases = tool('imf_list_databases', {
  description:
    'List IMF SDMX dataflows available on the portal. ' +
    'Entry point for every query: imf_get_database and imf_query_dataset both require a dataflow id obtained here. ' +
    'Vintage (historical snapshot) dataflows such as WEO_2025_OCT_VINTAGE are excluded by default; set include_vintages=true to include them. ' +
    'Results are paged — 50 per call by default, adjustable with limit and offset — and total_count ' +
    'reports how many dataflows matched. Descriptions are shortened here; imf_get_database returns ' +
    'the full text for a single dataflow.',
  annotations: {
    readOnlyHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  input: z.object({
    filter: z
      .string()
      .optional()
      .describe(
        'Optional name, ID, or description substring to filter results. Case-insensitive. ' +
          'Example: "exchange rate" returns ER and related dataflows.',
      ),
    include_vintages: z
      .boolean()
      .default(false)
      .describe(
        'Include vintage (historical snapshot) dataflows such as WEO_2025_OCT_VINTAGE. ' +
          'Default false — vintages are excluded to keep the discovery surface clean.',
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(MAX_LIMIT)
      .default(DEFAULT_LIMIT)
      .describe(
        `Maximum dataflows to return in this call. Default ${DEFAULT_LIMIT}, ceiling ${MAX_LIMIT}; ` +
          'total_count reports how many matched, so a partial page is always recognizable as one.',
      ),
    offset: z
      .number()
      .int()
      .min(0)
      .default(0)
      .describe(
        'Number of matching dataflows to skip before this page. Combine with limit to page through ' +
          'a broad or unfiltered catalog.',
      ),
  }),
  output: z.object({
    dataflows: z
      .array(
        z
          .object({
            id: z.string().describe('Dataflow identifier, e.g. WEO, BOP, CPI.'),
            agency_id: z.string().describe('Agency that publishes this dataflow, e.g. IMF.RES.'),
            version: z.string().describe('Dataflow version, e.g. 9.0.0.'),
            name: z.string().describe('Human-readable dataflow name.'),
            description: z
              .string()
              .optional()
              .describe(
                'Short description, cut to 200 characters and ended with … when longer. ' +
                  'imf_get_database and the imf://database/{dataflow_id} resource return the full text.',
              ),
          })
          .describe('A single IMF SDMX dataflow entry.'),
      )
      .describe(
        'This page of matching dataflows; pass the id to imf_get_database to resolve dimension codelists.',
      ),
    total_count: z
      .number()
      .describe(
        'Dataflows matching filter and include_vintages, before limit and offset are applied. ' +
          'Exceeds returned_count when more pages remain.',
      ),
    returned_count: z.number().describe('Dataflows in this page — the length of dataflows.'),
    offset: z.number().describe('Number of matching dataflows skipped before this page.'),
  }),
  errors: [
    {
      reason: 'dataflow_list_unavailable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'The IMF SDMX structure endpoint that backs the dataflow catalog did not return a usable response',
      retryable: true,
      recovery:
        'Retry in a few moments; the IMF SDMX 3.0 portal is intermittently unavailable and the catalog is cached for an hour once it succeeds.',
    },
  ],

  enrichment: {
    notice: z
      .string()
      .optional()
      .describe(
        'Populated when the filter matches nothing, or when matches remain beyond this page — ' +
          'explains why and names the next offset to request.',
      ),
    truncated: z
      .boolean()
      .optional()
      .describe('True when matching dataflows remain beyond this page.'),
    shown: z.number().optional().describe('Dataflows returned in this page.'),
    cap: z.number().optional().describe('The limit that bounded this page.'),
  },

  async handler(input, ctx) {
    const svc = getImfSdmxService();
    let dataflows = await svc.fetchDataflows(ctx);

    // Filter vintages
    if (!input.include_vintages) {
      dataflows = dataflows.filter((df) => !VINTAGE_PATTERN.test(df.id));
    }

    // Capture total before substring filter — used in empty-result notice.
    const totalBeforeFilter = dataflows.length;

    // Name/ID substring filter
    const filterLower = input.filter?.toLowerCase().trim();
    if (filterLower) {
      dataflows = dataflows.filter(
        (df) =>
          df.id.toLowerCase().includes(filterLower) ||
          df.name.toLowerCase().includes(filterLower) ||
          (df.description?.toLowerCase().includes(filterLower) ?? false),
      );
    }

    const totalCount = dataflows.length;
    const page = dataflows.slice(input.offset, input.offset + input.limit);

    ctx.log.info('Dataflows listed', {
      total: totalCount,
      returned: page.length,
      offset: input.offset,
      filter: input.filter,
    });

    const mappedDataflows = page.map((df) => ({
      id: df.id,
      agency_id: df.agencyId,
      version: df.version,
      name: df.name,
      ...(df.description ? { description: previewDescription(df.description) } : {}),
    }));

    if (filterLower && totalCount === 0) {
      ctx.enrich.notice(
        `No dataflows matched filter "${input.filter}". Try a broader term, or omit filter to browse all ${totalBeforeFilter} non-vintage dataflows. Set include_vintages=true to include historical snapshot entries.`,
      );
    } else if (totalCount > 0 && input.offset >= totalCount) {
      ctx.enrich.notice(
        `offset ${input.offset} is past the end of ${totalCount} matching dataflow(s) — request a smaller offset to see them.`,
      );
    } else if (input.offset + page.length < totalCount) {
      // A page that does not say it is one reads as the whole catalog. Only
      // offer a bigger page when one is available — pointing a caller already
      // at the ceiling back at `limit` sends them at the one control that
      // cannot move.
      const raiseLimit = input.limit < MAX_LIMIT ? ` raise limit (max ${MAX_LIMIT}),` : '';
      ctx.enrich.truncated({
        shown: page.length,
        cap: input.limit,
        guidance: `Showing ${input.offset + 1}–${input.offset + page.length} of ${totalCount} matching dataflows. Call again with offset=${input.offset + page.length} for the next page,${raiseLimit} or narrow with filter.`,
      });
    }

    return {
      dataflows: mappedDataflows,
      total_count: totalCount,
      returned_count: page.length,
      offset: input.offset,
    };
  },

  format: (result) => {
    // The page bounds ride the heading — a bare count beside a shorter list is
    // how a page gets mistaken for the whole catalog.
    const lines: string[] = [
      `**${result.total_count} dataflow${result.total_count === 1 ? '' : 's'} matched** — ` +
        `${result.returned_count} in this page, from offset ${result.offset}\n`,
    ];
    for (const df of result.dataflows) {
      lines.push(`### ${df.id}`);
      lines.push(`**Agency:** ${df.agency_id} | **Version:** ${df.version}`);
      lines.push(`**Name:** ${df.name}`);
      if (df.description) lines.push(df.description);
      lines.push('');
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
