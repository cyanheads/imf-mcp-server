/**
 * @fileoverview Server-specific environment variable configuration for imf-mcp-server.
 * @module config/server-config
 */

import { z } from '@cyanheads/mcp-ts-core';
import { parseEnvConfig } from '@cyanheads/mcp-ts-core/config';

const ServerConfigSchema = z.object({
  baseUrl: z
    .string()
    .default('https://api.imf.org/external/sdmx/3.0')
    .describe('IMF SDMX 3.0 base URL'),
  requestTimeoutMs: z.coerce
    .number()
    .default(30_000)
    .describe('Per-request timeout in milliseconds'),
});

let _config: z.infer<typeof ServerConfigSchema> | undefined;

/** Returns the parsed, cached server configuration. */
export function getServerConfig(): z.infer<typeof ServerConfigSchema> {
  _config ??= parseEnvConfig(ServerConfigSchema, {
    baseUrl: 'IMF_BASE_URL',
    requestTimeoutMs: 'IMF_REQUEST_TIMEOUT_MS',
  });
  return _config;
}
