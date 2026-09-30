/**
 * @fileoverview Registry, landing inventory, and discovery coverage for the
 * dataframe tools' two gates: DataCanvas presence gates all three, and
 * IMF_ENABLE_DATAFRAME_DROP additionally gates dataframe-drop.
 * @module tests/tools/imf-dataframe-drop.registry.test
 */

import { config, resetConfig } from '@cyanheads/mcp-ts-core/config';
import { createInMemoryStorage } from '@cyanheads/mcp-ts-core/testing';
import { createWorkerHandler } from '@cyanheads/mcp-ts-core/worker';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildServerManifest } from '../../node_modules/@cyanheads/mcp-ts-core/dist/core/serverManifest.js';
import { ToolRegistry } from '../../node_modules/@cyanheads/mcp-ts-core/dist/mcp-server/tools/tool-registration.js';
import { logger } from '../../node_modules/@cyanheads/mcp-ts-core/dist/utils/internal/logger.js';

type ToolDefinitionModule = typeof import('@/mcp-server/tools/definitions/index.js');

const executionContext = {
  waitUntil: () => undefined,
  passThroughOnException: () => undefined,
} as unknown as Parameters<ReturnType<typeof createWorkerHandler>['fetch']>[2];

/**
 * Load the definitions fresh under the given flags. The framework config caches
 * its first parse, so it is reset after stubbing for the canvas provider to be
 * read from this environment rather than an earlier test's.
 */
async function loadDefinitions(
  flag: 'false' | 'true',
  canvas: 'duckdb' | 'unset' = 'duckdb',
): Promise<ToolDefinitionModule> {
  vi.resetModules();
  vi.stubEnv('IMF_ENABLE_DATAFRAME_DROP', flag);
  vi.stubEnv('CANVAS_PROVIDER_TYPE', canvas === 'unset' ? undefined : canvas);
  resetConfig();
  return await import('@/mcp-server/tools/definitions/index.js');
}

const DATAFRAME_TOOLS = ['imf_dataframe_describe', 'imf_dataframe_query', 'imf_dataframe_drop'];

/** Each tool's disabled metadata as the landing inventory carries it. */
function disabledByName(tools: ToolDefinitionModule['allToolDefinitions']) {
  const inventory = buildServerManifest({
    config,
    tools,
    resources: [],
    prompts: [],
    title: 'imf-mcp-server',
  });
  return Object.fromEntries(inventory.definitions.tools.map((tool) => [tool.name, tool.disabled]));
}

async function registeredToolNames(tools: ToolDefinitionModule['allToolDefinitions']) {
  const registerTool = vi.fn();
  const server = {
    registerTool,
    sendPromptListChanged: vi.fn(),
    sendResourceListChanged: vi.fn(),
    sendToolListChanged: vi.fn(),
  };
  const registry = new ToolRegistry(tools, {
    logger,
    storage: createInMemoryStorage(),
  });

  await registry.registerAll(server as never);
  return registerTool.mock.calls.map(([name]) => name as string);
}

describe('imf_dataframe_drop registry gate', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
    resetConfig();
  });

  it('defaults the stringbool enable flag to false and parses explicit boolean strings', async () => {
    vi.resetModules();
    vi.stubEnv('IMF_ENABLE_DATAFRAME_DROP', undefined);
    const defaultConfig = await import('@/config/server-config.js');
    expect(defaultConfig.getServerConfig().enableDataframeDrop).toBe(false);

    vi.resetModules();
    vi.stubEnv('IMF_ENABLE_DATAFRAME_DROP', 'false');
    const falseConfig = await import('@/config/server-config.js');
    expect(falseConfig.getServerConfig().enableDataframeDrop).toBe(false);

    vi.resetModules();
    vi.stubEnv('IMF_ENABLE_DATAFRAME_DROP', 'true');
    const trueConfig = await import('@/config/server-config.js');
    expect(trueConfig.getServerConfig().enableDataframeDrop).toBe(true);
  });

  it('omits the disabled tool from registration but retains landing inventory metadata', async () => {
    const { allToolDefinitions } = await loadDefinitions('false');

    await expect(registeredToolNames(allToolDefinitions)).resolves.not.toContain(
      'imf_dataframe_drop',
    );

    const landingInventory = buildServerManifest({
      config,
      tools: allToolDefinitions,
      resources: [],
      prompts: [],
      title: 'imf-mcp-server',
    });
    const drop = landingInventory.definitions.tools.find(
      (tool) => tool.name === 'imf_dataframe_drop',
    );

    expect(drop?.disabled).toEqual({
      reason: 'Dataframe table cleanup is disabled in this deployment.',
      hint: 'IMF_ENABLE_DATAFRAME_DROP=true',
    });
    expect(landingInventory.definitionCounts.tools).toBe(6);
  });

  it('serves a definition-free discovery document and the disabled hint on the landing page', async () => {
    // DuckDB fails closed on a Worker, so the landing page is rendered canvas-off.
    const { allToolDefinitions } = await loadDefinitions('false', 'unset');
    const handler = createWorkerHandler({
      name: 'imf-mcp-server',
      title: 'imf-mcp-server',
      tools: allToolDefinitions,
      resources: [],
      prompts: [],
    });

    const discoveryResponse = await handler.fetch(
      new Request('http://localhost/.well-known/mcp.json'),
      {},
      executionContext,
    );
    const discovery = await discoveryResponse.json();
    const landingResponse = await handler.fetch(
      new Request('http://localhost/'),
      {},
      executionContext,
    );
    const landing = await landingResponse.text();

    expect(discoveryResponse.status).toBe(200);
    expect(discovery).not.toHaveProperty('definitions');
    expect(landingResponse.status).toBe(200);
    expect(landing).toContain('imf_dataframe_drop');
    expect(landing).toContain('IMF_ENABLE_DATAFRAME_DROP=true');
    expect(landing).toContain('CANVAS_PROVIDER_TYPE=duckdb');
  });

  it('registers the enabled tool and exposes an ordinary callable definition', async () => {
    const { allToolDefinitions, imfDataframeDrop } = await loadDefinitions('true');

    await expect(registeredToolNames(allToolDefinitions)).resolves.toContain('imf_dataframe_drop');
    expect(imfDataframeDrop).not.toHaveProperty('__mcpDisabled');
    expect(typeof imfDataframeDrop.handler).toBe('function');
  });
});

describe('dataframe tools DataCanvas gate', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
    resetConfig();
  });

  it('keeps all three out of tools/list without a canvas, shown disabled with the canvas hint', async () => {
    // The drop flag is on, so only the missing canvas can be what gates it.
    const { allToolDefinitions } = await loadDefinitions('true', 'unset');
    const registered = await registeredToolNames(allToolDefinitions);
    const disabled = disabledByName(allToolDefinitions);

    for (const name of DATAFRAME_TOOLS) {
      expect(registered).not.toContain(name);
      expect(disabled[name]).toEqual({
        reason: 'DataCanvas is not configured in this deployment.',
        hint: 'CANVAS_PROVIDER_TYPE=duckdb',
      });
    }
    expect(registered).toEqual(
      expect.arrayContaining(['imf_list_databases', 'imf_get_database', 'imf_query_dataset']),
    );
  });

  it('names both settings for dataframe-drop when neither the canvas nor the flag is set', async () => {
    const { allToolDefinitions } = await loadDefinitions('false', 'unset');

    expect(disabledByName(allToolDefinitions).imf_dataframe_drop).toEqual({
      reason: 'DataCanvas is not configured in this deployment.',
      hint: 'CANVAS_PROVIDER_TYPE=duckdb IMF_ENABLE_DATAFRAME_DROP=true',
    });
  });

  it('lists describe and query with a canvas, leaving drop to its own flag', async () => {
    const withoutDrop = await registeredToolNames(
      (await loadDefinitions('false')).allToolDefinitions,
    );
    expect(withoutDrop).toEqual(
      expect.arrayContaining(['imf_dataframe_describe', 'imf_dataframe_query']),
    );
    expect(withoutDrop).not.toContain('imf_dataframe_drop');

    const withDrop = await registeredToolNames((await loadDefinitions('true')).allToolDefinitions);
    expect(withDrop).toEqual(expect.arrayContaining(DATAFRAME_TOOLS));
  });
});
