/**
 * @fileoverview Tool: imf_get_database — fetch a dataflow's dimension list and codelists.
 * @module mcp-server/tools/definitions/imf-get-database.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getImfSdmxService } from '@/services/imf-sdmx/imf-sdmx-service.js';

const MAX_CODELIST_ENTRIES = 50;

export const imfGetDatabase = tool('imf_get_database', {
  description:
    "Fetch a dataflow's dimension list and complete codelist for each dimension. " +
    'Resolves human-readable terms to SDMX codes (e.g. "United States" → USA, ' +
    '"real GDP growth" → NGDP_RPCH). ' +
    'Required before imf_query_dataset — SDMX keys are opaque without codelist lookups. ' +
    'Country codes are ISO 3-letter (USA, GBR, DEU), not ISO 2-letter (US, GB, DE). ' +
    'The key_format field shows the exact dimension order required by imf_query_dataset.',
  annotations: {
    readOnlyHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  input: z.object({
    dataflow_id: z
      .string()
      .describe(
        'Dataflow identifier from imf_list_databases, e.g. WEO, BOP, CPI. ' + 'Case-sensitive.',
      ),
    agency_id: z
      .string()
      .optional()
      .describe(
        'Agency ID that publishes this dataflow, e.g. IMF.RES or IMF.STA. ' +
          'Auto-detected from the dataflow list when omitted.',
      ),
    version: z
      .string()
      .optional()
      .describe('Dataflow version, e.g. 9.0.0. Auto-detected from the dataflow list when omitted.'),
  }),
  output: z.object({
    dataflow_id: z.string().describe('Dataflow identifier, e.g. WEO, BOP, CPI.'),
    agency_id: z.string().describe('Agency that publishes this dataflow, e.g. IMF.RES, IMF.STA.'),
    version: z.string().describe('Dataflow version string, e.g. 9.0.0.'),
    name: z.string().describe('Human-readable dataflow name.'),
    description: z.string().optional().describe('Extended description, if available.'),
    key_format: z
      .string()
      .describe(
        'Dimension names in dot-separated keyPosition order, e.g. COUNTRY.INDICATOR.FREQUENCY. ' +
          'Use this exact format when constructing the key for imf_query_dataset.',
      ),
    dimensions: z
      .array(
        z
          .object({
            id: z.string().describe('Dimension identifier used in the key, e.g. COUNTRY.'),
            name: z.string().describe('Human-readable dimension name.'),
            position: z.number().describe('Zero-based position in the key string.'),
            codelist: z
              .array(
                z
                  .object({
                    id: z.string().describe('Machine code for this dimension value, e.g. USA.'),
                    name: z
                      .string()
                      .describe('Human-readable label for this value, e.g. United States.'),
                  })
                  .describe('A single codelist entry: machine code and human-readable name.'),
              )
              .describe(
                'Valid codes for this dimension. ' +
                  `Up to ${MAX_CODELIST_ENTRIES} entries shown; full list available via the imf://database resource.`,
              ),
            codelist_truncated: z
              .boolean()
              .describe(
                `True when the codelist has more than ${MAX_CODELIST_ENTRIES} entries and was truncated.`,
              ),
          })
          .describe('A single dimension with its codelist.'),
      )
      .describe('All dimensions of this dataflow with their codelists.'),
  }),

  errors: [
    {
      reason: 'dataflow_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'dataflow_id does not match any known dataflow on api.imf.org',
      recovery: 'Call imf_list_databases to browse available dataflow IDs.',
    },
    {
      reason: 'structure_unavailable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'api.imf.org returns non-200 on the DSD endpoint',
      recovery: 'Retry after a short wait; the IMF SDMX 3.0 portal is occasionally slow.',
    },
  ],

  async handler(input, ctx) {
    const svc = getImfSdmxService();

    const dataflow = await svc.findDataflow(input.dataflow_id, input.agency_id, input.version, ctx);
    if (!dataflow) {
      throw ctx.fail('dataflow_not_found', `Dataflow '${input.dataflow_id}' not found`, {
        dataflowId: input.dataflow_id,
        ...ctx.recoveryFor('dataflow_not_found'),
      });
    }

    let structure: Awaited<ReturnType<typeof svc.fetchDataflowStructure>>;
    try {
      structure = await svc.fetchDataflowStructure(
        input.dataflow_id,
        input.agency_id ?? dataflow.agencyId,
        input.version ?? dataflow.version,
        ctx,
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('not found')) {
        throw ctx.fail('dataflow_not_found', msg, ctx.recoveryFor('dataflow_not_found'));
      }
      throw ctx.fail('structure_unavailable', msg, ctx.recoveryFor('structure_unavailable'));
    }

    ctx.log.info('Dataflow structure fetched', {
      dataflowId: input.dataflow_id,
      dimensions: structure.dimensions.length,
    });

    const dimensions = structure.dimensions.map((dim) => {
      const truncated = dim.codelist.length > MAX_CODELIST_ENTRIES;
      return {
        id: dim.id,
        name: dim.name,
        position: dim.position,
        codelist: dim.codelist.slice(0, MAX_CODELIST_ENTRIES),
        codelist_truncated: truncated,
      };
    });

    return {
      dataflow_id: structure.dataflowId,
      agency_id: structure.agencyId,
      version: structure.version,
      name: structure.name,
      ...(structure.description ? { description: structure.description } : {}),
      key_format: structure.keyFormat,
      dimensions,
    };
  },

  format: (result) => {
    const lines: string[] = [];
    lines.push(`## ${result.name}`);
    lines.push(
      `**Dataflow:** ${result.dataflow_id} | **Agency:** ${result.agency_id} | **Version:** ${result.version}`,
    );
    if (result.description) lines.push(`\n${result.description}`);
    lines.push(`\n**Key format:** \`${result.key_format}\``);
    lines.push('\n### Dimensions\n');

    for (const dim of result.dimensions) {
      lines.push(`#### ${dim.id} (position ${dim.position})`);
      lines.push(`**Name:** ${dim.name}`);
      if (dim.codelist.length > 0) {
        lines.push('**Codes:**');
        for (const code of dim.codelist) {
          lines.push(`- \`${code.id}\` — ${code.name}`);
        }
        if (dim.codelist_truncated) {
          lines.push(`_(truncated at ${MAX_CODELIST_ENTRIES} entries)_`);
        }
      } else {
        lines.push('_(no codelist entries available)_');
      }
      lines.push('');
    }

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
