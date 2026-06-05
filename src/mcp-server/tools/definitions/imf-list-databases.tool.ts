/**
 * @fileoverview Tool: imf_list_databases — list all IMF SDMX dataflows available on the portal.
 * @module mcp-server/tools/definitions/imf-list-databases.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { getImfSdmxService } from '@/services/imf-sdmx/imf-sdmx-service.js';

const VINTAGE_PATTERN = /VINTAGE/i;

export const imfListDatabases = tool('imf_list_databases', {
  description:
    'List all IMF SDMX dataflows available on the portal (193 total). ' +
    'Entry point for every query: imf_get_database and imf_query_dataset both require a dataflow id obtained here. ' +
    'Vintage (historical snapshot) dataflows such as WEO_2025_OCT_VINTAGE are excluded by default; set include_vintages=true to include them.',
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
        'Optional name or ID substring to filter results. Case-insensitive. ' +
          'Example: "exchange rate" returns ER and related dataflows.',
      ),
    include_vintages: z
      .boolean()
      .default(false)
      .describe(
        'Include vintage (historical snapshot) dataflows such as WEO_2025_OCT_VINTAGE. ' +
          'Default false — vintages are excluded to keep the discovery surface clean.',
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
              .describe('Extended description of the dataflow, if available.'),
          })
          .describe('A single IMF SDMX dataflow entry.'),
      )
      .describe(
        'Matching dataflows; pass the id to imf_get_database to resolve dimension codelists.',
      ),
    total_count: z.number().describe('Total number of matching dataflows returned.'),
  }),

  async handler(input, ctx) {
    const svc = getImfSdmxService();
    let dataflows = await svc.fetchDataflows(ctx);

    // Filter vintages
    if (!input.include_vintages) {
      dataflows = dataflows.filter((df) => !VINTAGE_PATTERN.test(df.id));
    }

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

    ctx.log.info('Dataflows listed', { count: dataflows.length, filter: input.filter });

    const result = {
      dataflows: dataflows.map((df) => ({
        id: df.id,
        agency_id: df.agencyId,
        version: df.version,
        name: df.name,
        ...(df.description ? { description: df.description } : {}),
      })),
      total_count: dataflows.length,
    };

    return result;
  },

  format: (result) => {
    const lines: string[] = [
      `**${result.total_count} dataflow${result.total_count === 1 ? '' : 's'}**\n`,
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
