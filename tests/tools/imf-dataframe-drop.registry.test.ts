/**
 * @fileoverview Registry, landing inventory, and discovery coverage for dataframe-drop.
 * @module tests/tools/imf-dataframe-drop.registry.test
 */

import { config } from '@cyanheads/mcp-ts-core/config';
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

async function loadDefinitions(flag: 'false' | 'true'): Promise<ToolDefinitionModule> {
  vi.resetModules();
  vi.stubEnv('IMF_ENABLE_DATAFRAME_DROP', flag);
  return await import('@/mcp-server/tools/definitions/index.js');
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
    const { allToolDefinitions } = await loadDefinitions('false');
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
  });

  it('registers the enabled tool and exposes an ordinary callable definition', async () => {
    const { allToolDefinitions, imfDataframeDrop } = await loadDefinitions('true');

    await expect(registeredToolNames(allToolDefinitions)).resolves.toContain('imf_dataframe_drop');
    expect(imfDataframeDrop).not.toHaveProperty('__mcpDisabled');
    expect(typeof imfDataframeDrop.handler).toBe('function');
  });
});
