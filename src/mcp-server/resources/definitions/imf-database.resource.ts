/**
 * @fileoverview Resource: imf://database/{dataflow_id} — stable metadata for a dataflow.
 * @module mcp-server/resources/definitions/imf-database.resource
 */

import { resource, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { projectCodelist } from '@/mcp-server/codelist-page.js';
import { getImfSdmxService } from '@/services/imf-sdmx/imf-sdmx-service.js';

export const imfDatabaseResource = resource('imf://database/{dataflow_id}', {
  name: 'imf-database',
  title: 'IMF Dataflow Metadata',
  description:
    'Metadata for a single IMF SDMX dataflow — dimensions with their concept-scheme labels and ' +
    'bounded codelist previews, counts, key_format, name, and description. ' +
    'Stable URI-addressable reference for known dataflow IDs (WEO, BOP, CPI, etc.).',
  mimeType: 'application/json',
  params: z.object({
    dataflow_id: z
      .string()
      .describe('Dataflow identifier from imf_list_databases, e.g. WEO, BOP, CPI.'),
  }),
  output: z.object({
    dataflow_id: z.string().describe('Dataflow identifier, e.g. WEO.'),
    agency_id: z.string().describe('SDMX agency that maintains the dataflow, e.g. IMF.RES.'),
    version: z.string().describe("The dataflow's own version, e.g. 9.0.0."),
    dsd_version: z
      .string()
      .optional()
      .describe('Version of the underlying DSD when it differs from the dataflow version.'),
    structure_ref: z
      .string()
      .optional()
      .describe('Identifier of the underlying DSD, e.g. DSD_BOP, when the flow names one.'),
    name: z.string().describe('Human-readable dataflow name.'),
    description: z.string().optional().describe('Dataflow description when upstream supplies one.'),
    key_format: z
      .string()
      .describe('Dimension IDs in key order, e.g. COUNTRY.INDICATOR.FREQUENCY.'),
    dimensions: z
      .array(
        z
          .object({
            id: z.string().describe('Dimension ID as it appears in the key.'),
            name: z.string().describe('Human-readable dimension label from the concept scheme.'),
            position: z.number().describe('Zero-based slot of this dimension in the key.'),
            codelist: z
              .array(
                z
                  .object({
                    id: z.string().describe('Code as it appears in the key, e.g. USA.'),
                    name: z.string().describe('Human-readable label for the code.'),
                  })
                  .describe('A single codelist entry.'),
              )
              .describe('Bounded preview of valid codes for this dimension.'),
            codelist_truncated: z
              .boolean()
              .describe('True when matching codes were omitted after this preview.'),
            unfiltered_count: z
              .number()
              .describe('Codes in the complete resolved codelist before response bounding.'),
            matched_count: z.number().describe('Codes matching this unfiltered resource read.'),
            returned_count: z.number().describe('Codes returned in this bounded preview.'),
            offset: z.number().describe('Codes skipped before this preview; always 0 here.'),
            next_offset: z
              .number()
              .optional()
              .describe('Offset for imf_get_database when later codes remain.'),
          })
          .describe('A single dimension of the data structure definition.'),
      )
      .describe('Dimensions in key order, each with a bounded codelist preview and counts.'),
    continuation: z
      .object({
        tool: z
          .literal('imf_get_database')
          .describe('Tool that retrieves selected codelist pages.'),
        dataflow_id: z.string().describe('Dataflow ID to pass to the continuation tool.'),
        dimension_selector: z
          .literal('dimension_id')
          .describe('Parameter that selects the dimension to page.'),
        page_limit: z.literal('limit').describe('Parameter that controls selected page size.'),
        page_offset: z
          .literal('offset')
          .describe('Parameter that advances through selected pages.'),
      })
      .describe('Machine-readable path for retrieving every code through imf_get_database.'),
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
      when: 'api.imf.org returns no usable data structure for the selected dataflow',
      recovery:
        'Retry after a short wait; distinguish this upstream failure from an invalid dataflow ID.',
    },
    {
      reason: 'dataflow_list_unavailable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'The dataflow catalog used to resolve dataflow_id could not be fetched',
      retryable: true,
      recovery:
        'Retry in a few moments; the IMF SDMX 3.0 portal is intermittently unavailable and the catalog is cached for an hour once it succeeds.',
    },
  ],

  async handler(params, ctx) {
    const svc = getImfSdmxService();

    const dataflow = await svc.findDataflow(params.dataflow_id, undefined, undefined, ctx);
    if (!dataflow) {
      throw ctx.fail('dataflow_not_found', `Dataflow '${params.dataflow_id}' not found`, {
        dataflowId: params.dataflow_id,
        ...ctx.recoveryFor('dataflow_not_found'),
      });
    }

    let structure: Awaited<ReturnType<typeof svc.fetchDataflowStructure>>;
    try {
      structure = await svc.fetchDataflowStructure(
        params.dataflow_id,
        dataflow.agencyId,
        dataflow.version,
        ctx,
      );
    } catch (err: unknown) {
      if (err instanceof McpError && err.data?.reason === 'dataflow_list_unavailable') throw err;
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('not found')) {
        throw ctx.fail(
          'dataflow_not_found',
          `Dataflow '${params.dataflow_id}' not found`,
          {
            dataflowId: params.dataflow_id,
            ...ctx.recoveryFor('dataflow_not_found'),
          },
          { cause: err },
        );
      }
      throw ctx.fail(
        'structure_unavailable',
        `Structure unavailable for dataflow '${params.dataflow_id}'`,
        {
          dataflowId: params.dataflow_id,
          ...ctx.recoveryFor('structure_unavailable'),
        },
        { cause: err },
      );
    }

    return {
      dataflow_id: structure.dataflowId,
      agency_id: structure.agencyId,
      version: structure.version,
      ...(structure.dsdVersion ? { dsd_version: structure.dsdVersion } : {}),
      ...(structure.dsdId ? { structure_ref: structure.dsdId } : {}),
      name: structure.name,
      ...(structure.description ? { description: structure.description } : {}),
      key_format: structure.keyFormat,
      dimensions: structure.dimensions.map((dim) => ({
        id: dim.id,
        name: dim.name,
        position: dim.position,
        ...projectCodelist(dim.codelist),
      })),
      continuation: {
        tool: 'imf_get_database' as const,
        dataflow_id: structure.dataflowId,
        dimension_selector: 'dimension_id' as const,
        page_limit: 'limit' as const,
        page_offset: 'offset' as const,
      },
    };
  },
});
