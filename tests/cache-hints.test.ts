/**
 * @fileoverview Wire coverage for the IMF metadata cache policy.
 * @module tests/cache-hints
 */

import { createWorkerHandler } from '@cyanheads/mcp-ts-core/worker';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/services/imf-sdmx/imf-sdmx-service.js', () => ({
  getImfSdmxService: vi.fn(),
}));

import { IMF_METADATA_CACHE_HINTS } from '@/config/cache-hints.js';
import { allPromptDefinitions } from '@/mcp-server/prompts/definitions/index.js';
import { allResourceDefinitions } from '@/mcp-server/resources/definitions/index.js';
import { allToolDefinitions } from '@/mcp-server/tools/definitions/index.js';
import { getImfSdmxService } from '@/services/imf-sdmx/imf-sdmx-service.js';

const MODERN_PROTOCOL_REVISION = '2026-07-28';
const LEGACY_ENDPOINT = 'http://localhost/mcp';
const LEGACY_HEADERS = {
  'content-type': 'application/json',
  accept: 'application/json, text/event-stream',
} as const;
const CACHE_HINT = { ttlMs: 3_600_000, cacheScope: 'public' } as const;

const dataflow = {
  id: 'WEO',
  name: 'World Economic Outlook',
  description: 'World Economic Outlook data.',
  agencyId: 'IMF.RES',
  version: '9.0.0',
};

const structure = {
  dataflowId: 'WEO',
  agencyId: 'IMF.RES',
  version: '9.0.0',
  dsdId: 'WEO_DSD',
  name: 'World Economic Outlook structure',
  keyFormat: 'COUNTRY',
  dimensions: [
    {
      id: 'COUNTRY',
      name: 'Country',
      position: 0,
      codelist: [{ id: 'USA', name: 'United States' }],
    },
  ],
};

const executionContext = {
  waitUntil: () => undefined,
  passThroughOnException: () => undefined,
} as unknown as Parameters<ReturnType<typeof createWorkerHandler>['fetch']>[2];

function createHandler(
  cacheHints: typeof IMF_METADATA_CACHE_HINTS | null = IMF_METADATA_CACHE_HINTS,
) {
  return createWorkerHandler({
    name: 'imf-mcp-server',
    title: 'imf-mcp-server',
    ...(cacheHints && { cacheHints }),
    tools: allToolDefinitions,
    resources: allResourceDefinitions,
    prompts: allPromptDefinitions,
  });
}

function modernRequest(method: string, params: Record<string, unknown> = {}): Request {
  const name =
    typeof params.uri === 'string'
      ? params.uri
      : typeof params.name === 'string'
        ? params.name
        : undefined;
  return new Request(LEGACY_ENDPOINT, {
    method: 'POST',
    headers: {
      ...LEGACY_HEADERS,
      'MCP-Protocol-Version': MODERN_PROTOCOL_REVISION,
      'Mcp-Method': method,
      ...(name && { 'Mcp-Name': name }),
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method,
      params: {
        ...params,
        _meta: {
          'io.modelcontextprotocol/protocolVersion': MODERN_PROTOCOL_REVISION,
          'io.modelcontextprotocol/clientInfo': { name: 'imf-cache-hints-test', version: '1.0.0' },
          'io.modelcontextprotocol/clientCapabilities': {},
        },
      },
    }),
  });
}

function resultOf(body: string): Record<string, unknown> {
  const payload = body.startsWith('event:') || body.startsWith('data:') ? sseData(body) : body;
  const message = JSON.parse(payload) as { error?: unknown; result?: Record<string, unknown> };
  if (!message.result) throw new Error(`No result in response: ${body}`);
  return message.result;
}

function sseData(body: string): string {
  const line = body
    .split('\n')
    .find((candidate) => candidate.startsWith('data:') && candidate.includes('"result"'));
  if (!line) throw new Error(`No data frame in SSE body: ${body}`);
  return line.slice(5).trim();
}

describe('IMF metadata cache hints (#44)', () => {
  beforeEach(() => {
    vi.mocked(getImfSdmxService).mockReturnValue({
      fetchDataflows: vi.fn().mockResolvedValue([dataflow]),
      findDataflow: vi.fn().mockResolvedValue(dataflow),
      fetchDataflowStructure: vi.fn().mockResolvedValue(structure),
    } as never);
  });

  it.each([
    ['tools/list', {}],
    ['prompts/list', {}],
    ['resources/list', {}],
    ['resources/templates/list', {}],
    ['resources/read', { uri: 'imf://database/WEO' }],
    ['server/discover', {}],
  ])('emits the public one-hour hint for modern %s', async (method, params) => {
    const handler = createHandler();
    const response = await handler.fetch(modernRequest(method, params), {}, executionContext);
    const result = resultOf(await response.text());

    expect(response.status).toBe(200);
    expect(result).toMatchObject(CACHE_HINT);
  });

  it('does not add cache fields to a modern non-cacheable tool result', async () => {
    const handler = createHandler();
    const response = await handler.fetch(
      modernRequest('tools/call', { name: 'imf_list_databases', arguments: {} }),
      {},
      executionContext,
    );
    const result = resultOf(await response.text());

    expect(response.status).toBe(200);
    expect(result).not.toHaveProperty('ttlMs');
    expect(result).not.toHaveProperty('cacheScope');
  });

  /** Serves one legacy request and normalizes its session-derived event ID. */
  async function legacyBody(
    cacheHints: typeof IMF_METADATA_CACHE_HINTS | undefined,
    request: object,
  ) {
    const handler = createHandler(cacheHints ?? null);
    const init = await handler.fetch(
      new Request(LEGACY_ENDPOINT, {
        method: 'POST',
        headers: LEGACY_HEADERS,
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2025-11-25',
            capabilities: {},
            clientInfo: { name: 'imf-cache-hints-legacy', version: '1.0.0' },
          },
        }),
      }),
      {},
      executionContext,
    );
    await init.text();
    const sessionId = init.headers.get('mcp-session-id');
    expect(sessionId).toBeTruthy();

    const response = await handler.fetch(
      new Request(LEGACY_ENDPOINT, {
        method: 'POST',
        headers: { ...LEGACY_HEADERS, 'mcp-session-id': sessionId as string },
        body: JSON.stringify(request),
      }),
      {},
      executionContext,
    );
    return (await response.text()).replace(/^id: .*$/m, 'id: <event-id>');
  }

  it.each([
    ['tools/list', { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }],
    [
      'resources/read',
      {
        jsonrpc: '2.0',
        id: 2,
        method: 'resources/read',
        params: { uri: 'imf://database/WEO' },
      },
    ],
  ])('keeps the 2025 %s response byte-identical', async (_method, request) => {
    const without = await legacyBody(undefined, request);
    const withHints = await legacyBody(IMF_METADATA_CACHE_HINTS, request);

    expect(withHints).toBe(without);
    expect(withHints).not.toContain('ttlMs');
    expect(withHints).not.toContain('cacheScope');
  });
});
