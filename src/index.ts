#!/usr/bin/env node
/**
 * @fileoverview imf-mcp-server MCP server entry point.
 * @module index
 */

import { createApp } from '@cyanheads/mcp-ts-core';
import { IMF_METADATA_CACHE_HINTS } from './config/cache-hints.js';
import { getServerConfig } from './config/server-config.js';
import { allPromptDefinitions } from './mcp-server/prompts/definitions/index.js';
import { allResourceDefinitions } from './mcp-server/resources/definitions/index.js';
import { allToolDefinitions } from './mcp-server/tools/definitions/index.js';
import { setCanvas } from './services/canvas/canvas-accessor.js';
import { initImfSdmxService } from './services/imf-sdmx/imf-sdmx-service.js';

await createApp({
  name: 'imf-mcp-server',
  title: 'imf-mcp-server',
  /**
   * Every tool here answers from one upstream round-trip — none calls
   * `ctx.requestInput`, so nothing needs a session to come back to. Declaring it
   * in source rather than leaving it to `MCP_SESSION_MODE` keeps a deployment
   * that forgets the variable on the posture the surface was built for; a
   * deployment that does set it to a meaningful value still wins.
   */
  sessionMode: 'stateless',
  cacheHints: IMF_METADATA_CACHE_HINTS,
  tools: allToolDefinitions,
  resources: allResourceDefinitions,
  prompts: allPromptDefinitions,
  instructions:
    'IMF SDMX 3.0 macroeconomic data server. Keyless — no API key required.\n' +
    'Workflow: imf_list_databases → imf_get_database → imf_query_dataset\n' +
    'Country codes are ISO 3-letter (USA, GBR, DEU — not US, GB, DE).\n' +
    'With DataCanvas enabled (CANVAS_PROVIDER_TYPE=duckdb), large multi-country queries spill to it, and imf_query_dataset output_mode="canvas" explicitly stages smaller results. For any staged result, call imf_dataframe_describe before imf_dataframe_query; when enabled, imf_dataframe_drop removes one completed table. Without DataCanvas, an over-budget result returns its earliest observations with truncated=true, and retrieval_guidance says how to narrow the query.\n' +
    'Key legacy note: the IFS monolithic database is decomposed — use CPI, ER, IL, MFS_* instead.',
  setup(core) {
    const cfg = getServerConfig();
    initImfSdmxService(core.config, core.storage, cfg.baseUrl, cfg.requestTimeoutMs);
    setCanvas(core.canvas);
  },
});
