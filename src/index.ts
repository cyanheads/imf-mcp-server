#!/usr/bin/env node
/**
 * @fileoverview imf-mcp-server MCP server entry point.
 * @module index
 */

import { createApp } from '@cyanheads/mcp-ts-core';
import { getServerConfig } from './config/server-config.js';
import { allPromptDefinitions } from './mcp-server/prompts/definitions/index.js';
import { allResourceDefinitions } from './mcp-server/resources/definitions/index.js';
import { allToolDefinitions } from './mcp-server/tools/definitions/index.js';
import { setCanvas } from './services/canvas/canvas-accessor.js';
import { initImfSdmxService } from './services/imf-sdmx/imf-sdmx-service.js';

await createApp({
  tools: allToolDefinitions,
  resources: allResourceDefinitions,
  prompts: allPromptDefinitions,
  instructions:
    'IMF SDMX 3.0 macroeconomic data server. Keyless — no API key required.\n' +
    'Workflow: imf_list_databases → imf_get_database → imf_query_dataset\n' +
    'Country codes are ISO 3-letter (USA, GBR, DEU — not US, GB, DE).\n' +
    'Large multi-country queries spill to DataCanvas; use imf_dataframe_query for SQL analysis.\n' +
    'Key legacy note: the IFS monolithic database is decomposed — use CPI, ER, IL, MFS_* instead.',
  setup(core) {
    const cfg = getServerConfig();
    initImfSdmxService(core.config, core.storage, cfg.baseUrl, cfg.requestTimeoutMs);
    setCanvas(core.canvas);
  },
});
