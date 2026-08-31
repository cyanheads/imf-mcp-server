/**
 * @fileoverview Tool: imf_get_database — fetch a dataflow's dimension list with a
 * labelled, capped codelist preview per dimension, and a notice separating a
 * codelist_filter that matched nothing from a codelist that could not be resolved.
 * @module mcp-server/tools/definitions/imf-get-database.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import {
  CODELIST_PREVIEW_LIMIT,
  MAX_CODELIST_PAGE_LIMIT,
  projectCodelist,
} from '@/mcp-server/codelist-page.js';
import { getImfSdmxService } from '@/services/imf-sdmx/imf-sdmx-service.js';

/** IMF SDMX 3.0 data portal base URL — used to construct per-dataflow attribution links. */
const IMF_DATA_PORTAL = 'https://data.imf.org/';

export const imfGetDatabase = tool('imf_get_database', {
  description:
    "Fetch a dataflow's dimension list with a codelist preview for each dimension. " +
    'Resolves human-readable terms to SDMX codes (e.g. "United States" → USA, ' +
    '"Constant prices" → NGDP_RPCH). ' +
    'Required before imf_query_dataset — SDMX keys are opaque without codelist lookups. ' +
    `Each codelist is capped at the first ${CODELIST_PREVIEW_LIMIT} entries by default, including previews filtered by codelist_filter. ` +
    'Set dimension_id to retrieve one codelist with bounded limit/offset paging after the optional substring filter. ' +
    'The imf://database/{dataflow_id} resource provides the same bounded discovery summary. ' +
    'Country codes are ISO 3-letter (USA, GBR, DEU), not ISO 2-letter (US, GB, DE). ' +
    'The key_format field shows the exact dimension order required by imf_query_dataset. ' +
    'Note: codelists enumerate the code universe, not actual coverage — valid codes can still ' +
    'return no_data if the combination has no series in this dataflow.',
  annotations: {
    readOnlyHint: true,
    idempotentHint: true,
    openWorldHint: true,
  },
  input: z
    .object({
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
        .describe(
          'Dataflow version, e.g. 9.0.0. Auto-detected from the dataflow list when omitted.',
        ),
      codelist_filter: z
        .string()
        .trim()
        .min(1)
        .optional()
        .describe(
          "Optional case-insensitive substring to search within each dimension's codelist (code ID and name). " +
            `Filtering runs before the ${CODELIST_PREVIEW_LIMIT}-entry preview or selected-dimension page. ` +
            'Example: "CPI" or "Constant prices" surfaces matching WEO indicator codes.',
        ),
      dimension_id: z
        .string()
        .trim()
        .min(1)
        .optional()
        .describe(
          'Exact dimension ID from this tool, e.g. INDICATOR. Select one dimension to page beyond its preview.',
        ),
      limit: z
        .number()
        .int()
        .min(1)
        .max(MAX_CODELIST_PAGE_LIMIT)
        .optional()
        .describe(
          `Entries to return from the selected dimension. Valid only with dimension_id; default ${CODELIST_PREVIEW_LIMIT}, maximum ${MAX_CODELIST_PAGE_LIMIT}.`,
        ),
      offset: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe(
          'Matching entries to skip in the selected dimension before this page. Valid only with dimension_id; default 0.',
        ),
    })
    .superRefine((input, refinement) => {
      if (
        input.dimension_id === undefined &&
        (input.limit !== undefined || input.offset !== undefined)
      ) {
        refinement.addIssue({
          code: 'custom',
          path: ['dimension_id'],
          message: 'dimension_id is required when limit or offset is provided.',
        });
      }
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
        "This dataflow's own description in full — not the shared DSD's, and not the " +
          'shortened preview imf_list_databases returns for the same id. Absent when the ' +
          'dataflow publishes none.',
      ),
    codelist_filter: z
      .string()
      .optional()
      .describe(
        'Echo of the codelist_filter that produced this result. Absent when no filter was applied — ' +
          'an empty codelist then means the codelist could not be resolved, not that the filter missed.',
      ),
    dimension_id: z
      .string()
      .optional()
      .describe('Selected dimension ID. Absent when previews for every dimension were returned.'),
    key_format: z
      .string()
      .describe(
        'Dimension names in dot-separated keyPosition order, e.g. COUNTRY.INDICATOR.FREQUENCY. ' +
          'Use this exact format when constructing the key for imf_query_dataset.',
      ),
    truncated: z.boolean().describe('True when any returned dimension page omits matching codes.'),
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
                  `Unselected previews show up to ${CODELIST_PREVIEW_LIMIT} entries after optional filtering. ` +
                  'Select dimension_id and use limit/offset for a bounded page of up to 200 entries. ' +
                  'Empty means the filter matched nothing when codelist_filter is echoed back, ' +
                  'and that the codelist could not be resolved when it is not — see notice.',
              ),
            codelist_truncated: z
              .boolean()
              .describe('True when matching codes were omitted before or after this page.'),
            unfiltered_count: z
              .number()
              .describe(
                'Codes in the complete resolved codelist before codelist_filter is applied.',
              ),
            matched_count: z
              .number()
              .describe('Codes matching codelist_filter before limit and offset are applied.'),
            returned_count: z.number().describe('Codes returned in this dimension page.'),
            offset: z.number().describe('Matching codes skipped before this dimension page.'),
            next_offset: z
              .number()
              .optional()
              .describe('Offset for the next page when later matching codes remain.'),
          })
          .describe('A single dimension with its codelist.'),
      )
      .describe('All dimension previews, or the one selected dimension page.'),
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
      reason: 'dimension_not_found',
      code: JsonRpcErrorCode.ValidationError,
      when: 'dimension_id does not match a dimension in the selected dataflow',
      recovery: 'Use an exact dimension ID returned by imf_get_database for this dataflow.',
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
          'resolvable codelist, or when offset is past the final match.',
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
      if (err instanceof McpError && err.data?.reason === 'dataflow_list_unavailable') throw err;
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

    const selectedDimension = input.dimension_id
      ? structure.dimensions.find((dimension) => dimension.id === input.dimension_id)
      : undefined;
    if (input.dimension_id && !selectedDimension) {
      const availableDimensions = structure.dimensions.map((dimension) => dimension.id);
      throw ctx.fail(
        'dimension_not_found',
        `Dimension '${input.dimension_id}' does not exist in dataflow '${structure.dataflowId}'`,
        {
          availableDimensions,
          recovery: {
            hint: `Use one of these dimension IDs: ${availableDimensions.join(', ')}.`,
          },
        },
      );
    }

    const dimensionsToProject = selectedDimension ? [selectedDimension] : structure.dimensions;
    const dimensions = dimensionsToProject.map((dimension) => ({
      id: dimension.id,
      name: dimension.name,
      position: dimension.position,
      ...projectCodelist(dimension.codelist, {
        ...(input.codelist_filter ? { filter: input.codelist_filter } : {}),
        ...(selectedDimension && input.limit !== undefined ? { limit: input.limit } : {}),
        ...(selectedDimension && input.offset !== undefined ? { offset: input.offset } : {}),
      }),
    }));

    /**
     * An empty codelist has two causes that render identically but need opposite
     * next steps — broaden the filter, or choose another dimension/dataflow. The notice
     * names which one applies; the codelist_filter echo lets format() do the same
     * per dimension.
     */
    if (
      input.codelist_filter &&
      dimensions.some((dimension) => dimension.unfiltered_count > 0) &&
      dimensions.every((dimension) => dimension.matched_count === 0)
    ) {
      const counts = dimensions
        .map((dimension) => `${dimension.id} (${dimension.unfiltered_count})`)
        .join(', ');
      ctx.enrich.notice(
        `No codes matched codelist_filter "${input.codelist_filter}" in any dimension. ` +
          `Unfiltered entry counts: ${counts}. ` +
          `Try a shorter or broader substring, or omit codelist_filter to browse the first ${CODELIST_PREVIEW_LIMIT} entries per dimension.`,
      );
    } else {
      const unresolved = dimensions
        .filter((dimension) => dimension.unfiltered_count === 0)
        .map((dimension) => dimension.id);
      if (unresolved.length > 0) {
        ctx.enrich.notice(
          `No codelist resolved for ${unresolved.join(', ')} — this response lists no codes for ${unresolved.length === 1 ? 'that position' : 'those positions'} of the key. ` +
            'Check another dimension or dataflow; the structure did not provide codes for this position.',
        );
      } else if (
        selectedDimension &&
        dimensions[0]?.matched_count &&
        dimensions[0].returned_count === 0
      ) {
        ctx.enrich.notice(
          `offset ${dimensions[0].offset} is past the end of ${dimensions[0].matched_count} matching code(s) for ${selectedDimension.id}; request a smaller offset.`,
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
      ...(input.dimension_id ? { dimension_id: input.dimension_id } : {}),
      key_format: structure.keyFormat,
      truncated: dimensions.some((dimension) => dimension.codelist_truncated),
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
        `**Codelist filter:** \`${result.codelist_filter}\` — applied before each bounded preview or selected-dimension page.`,
      );
    }
    if (result.dimension_id) lines.push(`**Selected dimension:** \`${result.dimension_id}\``);
    if (result.truncated) {
      lines.push('**Truncated:** true — matching codes were omitted outside the returned page.');
    }
    lines.push(`\n**Key format:** \`${result.key_format}\``);
    lines.push('\n### Dimensions\n');

    for (const dim of result.dimensions) {
      lines.push(`#### ${dim.id} (position ${dim.position})`);
      lines.push(`**Name:** ${dim.name}`);
      lines.push(
        `**Codelist page:** ${dim.returned_count} returned from offset ${dim.offset}; ${dim.matched_count} matched; ${dim.unfiltered_count} before filtering.`,
      );
      if (dim.codelist.length > 0) {
        lines.push('**Codes:**');
        for (const code of dim.codelist) {
          lines.push(`- \`${code.id}\` — ${code.name}`);
        }
        if (dim.next_offset !== undefined) {
          lines.push(
            `_(more matches remain — call imf_get_database with dimension_id="${dim.id}" and offset=${dim.next_offset}; limit may be up to ${MAX_CODELIST_PAGE_LIMIT})_`,
          );
        }
      } else if (dim.matched_count > 0) {
        lines.push(
          `_(offset ${dim.offset} is past the end of ${dim.matched_count} matching codes)_`,
        );
      } else if (result.codelist_filter && dim.unfiltered_count > 0) {
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
