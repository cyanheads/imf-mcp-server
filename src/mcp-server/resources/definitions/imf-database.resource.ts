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
    'Metadata for a single IMF SDMX dataflow — dimensions with full codelists, key_format, name, and description. ' +
    'Stable URI-addressable reference for known dataflow IDs (WEO, BOP, CPI, etc.).',
  mimeType: 'application/json',
  params: z.object({
    dataflow_id: z
      .string()
      .describe('Dataflow identifier from imf_list_databases, e.g. WEO, BOP, CPI.'),
  }),

  async handler(params, ctx) {
    const svc = getImfSdmxService();

    const dataflow = await svc.findDataflow(params.dataflow_id, undefined, undefined, ctx);
    if (!dataflow) {
      throw notFound(`Dataflow '${params.dataflow_id}' not found`, {
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
            dataflowId: params.dataflow_id,
          },
          { cause: err },
        );
      }
      throw serviceUnavailable(
        `Structure unavailable for dataflow '${params.dataflow_id}'`,
        {
          dataflowId: params.dataflow_id,
        },
        { cause: err },
      );
    }

    return {
      dataflow_id: structure.dataflowId,
      agency_id: structure.agencyId,
      version: structure.version,
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
