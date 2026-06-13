/**
 * @fileoverview Tests for the imf_list_databases tool.
 * @module tests/tools/imf-list-databases.tool.test
 */

import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/services/imf-sdmx/imf-sdmx-service.js', () => ({
  getImfSdmxService: vi.fn(),
}));

import { imfListDatabases } from '@/mcp-server/tools/definitions/imf-list-databases.tool.js';
import { getImfSdmxService } from '@/services/imf-sdmx/imf-sdmx-service.js';

const MOCK_DATAFLOWS = [
  { id: 'WEO', agencyId: 'IMF.RES', version: '9.0.0', name: 'World Economic Outlook' },
  { id: 'BOP', agencyId: 'IMF.STA', version: '1.0.0', name: 'Balance of Payments' },
  {
    id: 'WEO_2025_OCT_VINTAGE',
    agencyId: 'IMF.RES',
    version: '1.0.0',
    name: 'WEO Oct 2025 Vintage',
  },
  {
    id: 'CPI',
    agencyId: 'IMF.STA',
    version: '2.0.0',
    name: 'Consumer Price Index',
    description: 'Price indices',
  },
];

describe('imfListDatabases', () => {
  let mockSvc: { fetchDataflows: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    mockSvc = { fetchDataflows: vi.fn().mockResolvedValue(MOCK_DATAFLOWS) };
    (getImfSdmxService as ReturnType<typeof vi.fn>).mockReturnValue(mockSvc);
  });

  it('returns all non-vintage dataflows by default', async () => {
    const ctx = createMockContext({ tenantId: 'test' });
    const input = imfListDatabases.input.parse({});
    const result = await imfListDatabases.handler(input, ctx);

    expect(result.total_count).toBe(3);
    expect(result.dataflows.map((d) => d.id)).toEqual(['WEO', 'BOP', 'CPI']);
  });

  it('includes vintage dataflows when include_vintages=true', async () => {
    const ctx = createMockContext({ tenantId: 'test' });
    const input = imfListDatabases.input.parse({ include_vintages: true });
    const result = await imfListDatabases.handler(input, ctx);

    expect(result.total_count).toBe(4);
    expect(result.dataflows.some((d) => d.id === 'WEO_2025_OCT_VINTAGE')).toBe(true);
  });

  it('filters by name substring (case-insensitive)', async () => {
    const ctx = createMockContext({ tenantId: 'test' });
    const input = imfListDatabases.input.parse({ filter: 'balance' });
    const result = await imfListDatabases.handler(input, ctx);

    expect(result.total_count).toBe(1);
    expect(result.dataflows[0].id).toBe('BOP');
  });

  it('filters by description substring', async () => {
    const ctx = createMockContext({ tenantId: 'test' });
    const input = imfListDatabases.input.parse({ filter: 'price indices' });
    const result = await imfListDatabases.handler(input, ctx);

    expect(result.total_count).toBe(1);
    expect(result.dataflows[0].id).toBe('CPI');
  });

  it('returns empty list when filter matches nothing', async () => {
    const ctx = createMockContext({ tenantId: 'test' });
    const input = imfListDatabases.input.parse({ filter: 'xyznonexistent' });
    const result = await imfListDatabases.handler(input, ctx);

    expect(result.total_count).toBe(0);
    expect(result.dataflows).toHaveLength(0);
  });

  it('enriches notice when filter matches nothing', async () => {
    const ctx = createMockContext({ tenantId: 'test' });
    const input = imfListDatabases.input.parse({ filter: 'xyznonexistent' });
    await imfListDatabases.handler(input, ctx);

    const notice = getEnrichment(ctx).notice as string | undefined;
    expect(notice).toBeDefined();
    expect(notice).toContain('xyznonexistent');
    expect(notice).toContain('non-vintage');
  });

  it('does not enrich notice when filter matches results', async () => {
    const ctx = createMockContext({ tenantId: 'test' });
    const input = imfListDatabases.input.parse({ filter: 'balance' });
    await imfListDatabases.handler(input, ctx);

    expect(getEnrichment(ctx).notice).toBeUndefined();
  });

  it('does not enrich notice when no filter is provided', async () => {
    const ctx = createMockContext({ tenantId: 'test' });
    const input = imfListDatabases.input.parse({});
    await imfListDatabases.handler(input, ctx);

    expect(getEnrichment(ctx).notice).toBeUndefined();
  });

  it('formats output with agency and name info', () => {
    const output = {
      dataflows: [
        { id: 'WEO', agency_id: 'IMF.RES', version: '9.0.0', name: 'World Economic Outlook' },
      ],
      total_count: 1,
    };
    const blocks = imfListDatabases.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('WEO');
    expect(text).toContain('IMF.RES');
    expect(text).toContain('World Economic Outlook');
    expect(text).toContain('9.0.0');
  });

  it('formats optional description when present', () => {
    const output = {
      dataflows: [
        {
          id: 'CPI',
          agency_id: 'IMF.STA',
          version: '2.0.0',
          name: 'Consumer Price Index',
          description: 'Price indices for 90+ countries',
        },
      ],
      total_count: 1,
    };
    const blocks = imfListDatabases.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('Price indices for 90+ countries');
  });

  it('does not render notice in format output (notice is enrichment)', () => {
    // notice lives in the enrichment block — the framework mirrors it into the
    // content[] trailer, so format() must not render it from the domain payload.
    const output = {
      dataflows: [],
      total_count: 0,
    };
    const blocks = imfListDatabases.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).not.toContain('No dataflows matched');
  });

  // -------------------------------------------------------------------------
  // #9: filter matches descriptions (not just name/ID)
  // -------------------------------------------------------------------------

  it('returns a description-only match when filter matches description but not name or ID', async () => {
    // APDREO has a description about "regional economic outlook" but the ID/name don't match "regional"
    const dataflows = [
      {
        id: 'APDREO',
        agencyId: 'IMF.STA',
        version: '1.0.0',
        name: 'APD Regional Economic Outlook',
        description: 'Asia Pacific regional economic outlook database',
      },
      {
        id: 'WEO',
        agencyId: 'IMF.RES',
        version: '9.0.0',
        name: 'World Economic Outlook',
      },
    ];
    mockSvc.fetchDataflows.mockResolvedValue(dataflows);

    const ctx = createMockContext({ tenantId: 'test' });
    // "asia pacific" matches only via description on APDREO (and not WEO)
    const input = imfListDatabases.input.parse({ filter: 'asia pacific' });
    const result = await imfListDatabases.handler(input, ctx);

    expect(result.total_count).toBe(1);
    expect(result.dataflows[0].id).toBe('APDREO');
  });
});
