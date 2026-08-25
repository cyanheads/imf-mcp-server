/**
 * @fileoverview Resource: imf://database/{dataflow_id} — stable metadata for a dataflow.
 * @module mcp-server/resources/definitions/imf-database.resource
 */

import { resource, z } from '@cyanheads/mcp-ts-core';
import { notFound, serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
import { getImfSdmxService } from '@/services/imf-sdmx/imf-sdmx-service.js';

export const imfDatabaseResource = resource('imf://database/{dataflow_id}', {
  name: 'imf-database',
  title: 'IMF Dataflow Metadata',
  description:
    'Metadata for a single IMF SDMX dataflow — dimensions with their concept-scheme labels and ' +
    'full codelists, key_format, name, and description. ' +
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
              .describe('Every valid code for this dimension — full list, never truncated.'),
          })
          .describe('A single dimension of the data structure definition.'),
      )
      .describe('Dimensions in key order, each with its complete codelist.'),
  }),

  async handler(params, ctx) {
    const svc = getImfSdmxService();

    const dataflow = await svc.findDataflow(params.dataflow_id, undefined, undefined, ctx);
    if (!dataflow) {
      throw notFound(`Dataflow '${params.dataflow_id}' not found`, {
        reason: 'dataflow_not_found',
        dataflowId: params.dataflow_id,
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
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('not found')) {
        throw notFound(
          `Dataflow '${params.dataflow_id}' not found`,
          {
            reason: 'dataflow_not_found',
            dataflowId: params.dataflow_id,
          },
          { cause: err },
        );
      }
      throw serviceUnavailable(
        `Structure unavailable for dataflow '${params.dataflow_id}'`,
        {
          reason: 'structure_unavailable',
          dataflowId: params.dataflow_id,
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
        codelist: dim.codelist,
      })),
    };
  },
});
