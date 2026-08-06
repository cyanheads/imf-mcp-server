/**
 * @fileoverview Tool: imf_get_database — fetch a dataflow's dimension list with a
 * labelled, capped codelist preview per dimension, and a notice separating a
 * codelist_filter that matched nothing from a codelist that could not be resolved.
 * @module mcp-server/tools/definitions/imf-get-database.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getImfSdmxService } from '@/services/imf-sdmx/imf-sdmx-service.js';

const MAX_CODELIST_ENTRIES = 50;

/** IMF SDMX 3.0 data portal base URL — used to construct per-dataflow attribution links. */
const IMF_DATA_PORTAL = 'https://data.imf.org/';

export const imfGetDatabase = tool('imf_get_database', {
  description:
    "Fetch a dataflow's dimension list with a codelist preview for each dimension. " +
    'Resolves human-readable terms to SDMX codes (e.g. "United States" → USA, ' +
    '"real GDP growth" → NGDP_RPCH). ' +
    'Required before imf_query_dataset — SDMX keys are opaque without codelist lookups. ' +
    `Each codelist is capped at the first ${MAX_CODELIST_ENTRIES} entries by default; ` +
    'set codelist_filter to return every entry matching a substring, or read the ' +
    'imf://database/{dataflow_id} resource for complete codelists. ' +
    'Country codes are ISO 3-letter (USA, GBR, DEU), not ISO 2-letter (US, GB, DE). ' +
    'The key_format field shows the exact dimension order required by imf_query_dataset. ' +
    'Note: codelists enumerate the code universe, not actual coverage — valid codes can still ' +
    'return no_data if the combination has no series in this dataflow.',
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
    codelist_filter: z
      .string()
      .optional()
      .describe(
        "Optional case-insensitive substring to search within each dimension's codelist (code ID and name). " +
          'When set, returns all matching entries per dimension instead of the first-50 window — ' +
          'useful for large codelists like WEO INDICATOR (145 entries). ' +
          'Example: "CPI" or "PCPIPCH" surfaces consumer price index codes without hitting the 50-entry cap.',
      ),
  }),
  output: z.object({
    dataflow_id: z.string().describe('Dataflow identifier, e.g. WEO, BOP, CPI.'),
    agency_id: z.string().describe('Agency that publishes this dataflow, e.g. IMF.RES, IMF.STA.'),
    version: z.string().describe('Dataflow version string, e.g. 9.0.0.'),
    dsd_version: z
      .string()
      .optional()
      .describe(
        'Version of the underlying data structure definition (DSD) that backs this dataflow. ' +
          'Differs from version when the dataflow references a shared DSD (e.g. IIP → DSD_BOP at 24.0.0).',
      ),
    structure_ref: z
      .string()
      .optional()
      .describe(
        'Identifier of the underlying DSD, e.g. DSD_BOP. Several dataflows can share one DSD.',
      ),
    name: z.string().describe('Human-readable dataflow name.'),
    description: z
      .string()
      .optional()
      .describe(
        "This dataflow's own description, matching what imf_list_databases reports for the " +
          "same id — not the shared DSD's. Absent when the dataflow publishes none.",
      ),
    codelist_filter: z
      .string()
      .optional()
      .describe(
        'Echo of the codelist_filter that produced this result. Absent when no filter was applied — ' +
          'an empty codelist then means the codelist could not be resolved, not that the filter missed.',
      ),
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
            name: z
              .string()
              .describe(
                'Human-readable dimension label from the DSD concept scheme, e.g. Weight Type for WGT_TYPE. ' +
                  'Falls back to the dimension id when the structure names no concept.',
              ),
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
                  `Up to ${MAX_CODELIST_ENTRIES} entries shown when no codelist_filter is set; ` +
                  'use codelist_filter to search large codelists or the imf://database resource for the full list. ' +
                  'Empty means the filter matched nothing when codelist_filter is echoed back, ' +
                  'and that the codelist could not be resolved when it is not — see notice.',
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
    source: z
      .string()
      .describe(
        'Attribution string required by IMF data terms: "Source: International Monetary Fund, <dataflow name>, <link>".',
      ),
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
    {
      reason: 'dataflow_list_unavailable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'The dataflow catalog that dataflow_id is resolved against could not be fetched — fires before the DSD lookup is attempted',
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
        'Populated when a codelist_filter matched no entries anywhere, or when a dimension has no ' +
          'resolvable codelist — the two produce the same empty array and need opposite next steps.',
      ),
  },

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

    const codelistFilterLower = input.codelist_filter?.toLowerCase().trim();

    const dimensions = structure.dimensions.map((dim) => {
      let entries = dim.codelist;
      let truncated: boolean;

      if (codelistFilterLower) {
        // Filter mode: return all matching entries (no cap)
        entries = entries.filter(
          (e) =>
            e.id.toLowerCase().includes(codelistFilterLower) ||
            e.name.toLowerCase().includes(codelistFilterLower),
        );
        truncated = false;
      } else {
        // Default mode: cap at MAX_CODELIST_ENTRIES
        truncated = entries.length > MAX_CODELIST_ENTRIES;
        entries = entries.slice(0, MAX_CODELIST_ENTRIES);
      }

      return {
        id: dim.id,
        name: dim.name,
        position: dim.position,
        codelist: entries,
        codelist_truncated: truncated,
      };
    });

    /**
     * An empty codelist has two causes that render identically but need opposite
     * next steps — broaden the filter, or fall back to the resource. The notice
     * names which one applies; the codelist_filter echo lets format() do the same
     * per dimension.
     */
    if (codelistFilterLower && dimensions.every((d) => d.codelist.length === 0)) {
      const counts = structure.dimensions.map((d) => `${d.id} (${d.codelist.length})`).join(', ');
      ctx.enrich.notice(
        `No codes matched codelist_filter "${input.codelist_filter}" in any dimension. ` +
          `Unfiltered entry counts: ${counts}. ` +
          `Try a shorter or broader substring, or omit codelist_filter to browse the first ${MAX_CODELIST_ENTRIES} entries per dimension.`,
      );
    } else if (!codelistFilterLower) {
      const unresolved = dimensions.filter((d) => d.codelist.length === 0).map((d) => d.id);
      if (unresolved.length > 0) {
        ctx.enrich.notice(
          `No codelist resolved for ${unresolved.join(', ')} — this response lists no codes for ${unresolved.length === 1 ? 'that position' : 'those positions'} of the key. ` +
            `Read imf://database/${structure.dataflowId}, which returns every codelist the structure ships, uncapped.`,
        );
      }
    }

    return {
      dataflow_id: structure.dataflowId,
      agency_id: structure.agencyId,
      version: structure.version,
      ...(structure.dsdVersion ? { dsd_version: structure.dsdVersion } : {}),
      ...(structure.dsdId ? { structure_ref: structure.dsdId } : {}),
      name: structure.name,
      ...(structure.description ? { description: structure.description } : {}),
      ...(input.codelist_filter ? { codelist_filter: input.codelist_filter } : {}),
      key_format: structure.keyFormat,
      dimensions,
      source: `Source: International Monetary Fund, ${structure.name}, ${IMF_DATA_PORTAL}`,
    };
  },

  format: (result) => {
    const lines: string[] = [];
    lines.push(`## ${result.name}`);
    lines.push(
      `**Dataflow:** ${result.dataflow_id} | **Agency:** ${result.agency_id} | **Version:** ${result.version}`,
    );
    if (result.structure_ref || result.dsd_version) {
      const dsdParts: string[] = [];
      if (result.structure_ref) dsdParts.push(`**Structure:** ${result.structure_ref}`);
      if (result.dsd_version) dsdParts.push(`**DSD version:** ${result.dsd_version}`);
      lines.push(dsdParts.join(' | '));
    }
    if (result.description) lines.push(`\n${result.description}`);
    if (result.codelist_filter) {
      lines.push(
        `**Codelist filter:** \`${result.codelist_filter}\` — codes below are every match, not the first ${MAX_CODELIST_ENTRIES}.`,
      );
    }
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
          lines.push(
            `_(truncated at ${MAX_CODELIST_ENTRIES} entries — use codelist_filter to search, or imf://database/{dataflow_id} for the full list)_`,
          );
        }
      } else if (result.codelist_filter) {
        // The two empty causes need opposite next steps, so they render as
        // different lines. What to do about each is stated once — in the filter
        // header above, or in the enrichment notice — not repeated per dimension.
        lines.push(`_(no matches for codelist_filter \`${result.codelist_filter}\`)_`);
      } else {
        lines.push('_(no codelist resolved — see notice)_');
      }
      lines.push('');
    }

    lines.push(`_${result.source}_`);

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
