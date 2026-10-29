/**
 * @fileoverview Server-specific environment variable configuration for imf-mcp-server.
 * @module config/server-config
 */

import { z } from '@cyanheads/mcp-ts-core';
import { ConfigSchema, normalizeEnv, parseEnvConfig } from '@cyanheads/mcp-ts-core/config';

const ServerConfigSchema = z.object({
  baseUrl: z
    .string()
    .default('https://api.imf.org/external/sdmx/3.0')
    .describe('IMF SDMX 3.0 base URL'),
  // Feeds AbortSignal.timeout(), which rejects a negative, fractional, or past-2^32 value at call time.
  requestTimeoutMs: z.coerce
    .number()
    .int()
    .min(1)
    .max(2_147_483_647)
    .default(30_000)
    .describe('Per-request timeout in milliseconds'),
  enableDataframeDrop: z
    .stringbool()
    .default(false)
    .describe('Whether the destructive imf_dataframe_drop tool is enabled'),
});

const SERVER_ENV = {
  baseUrl: 'IMF_BASE_URL',
  requestTimeoutMs: 'IMF_REQUEST_TIMEOUT_MS',
  enableDataframeDrop: 'IMF_ENABLE_DATAFRAME_DROP',
} as const;

let _config: z.infer<typeof ServerConfigSchema> | undefined;

/**
 * Returns the parsed, cached server configuration.
 * @throws {McpError} `ConfigurationError` naming each invalid variable.
 */
export function getServerConfig(): z.infer<typeof ServerConfigSchema> {
  _config ??= parseEnvConfig(ServerConfigSchema, SERVER_ENV);
  return _config;
}

/**
 * The two gates below decide which dataframe tools are listed. They run at
 * module load, before `createApp()`, because tools are defined before `setup()`
 * wires anything. Each reads its one variable through the same schema field as
 * the full parse but never throws: a full parse here would turn any invalid
 * variable into a raw stack trace ahead of the framework's startup banner. A
 * value that fails validation leaves the gated tool off, and startup then stops
 * on it with the banner — `createApp()` parses the framework config and
 * `setup()` calls `getServerConfig()`.
 */

/** Whether `CANVAS_PROVIDER_TYPE` configures DataCanvas, without parsing the rest of the framework config. */
export function isCanvasConfigured(): boolean {
  const providerType = ConfigSchema.shape.canvas.shape.providerType.safeParse(
    normalizeEnv(process.env).CANVAS_PROVIDER_TYPE,
  );
  return providerType.success && providerType.data !== 'none';
}

/** Whether `IMF_ENABLE_DATAFRAME_DROP` enables imf_dataframe_drop, without parsing the rest of the server config. */
export function isDataframeDropEnabled(): boolean {
  const flag = ServerConfigSchema.shape.enableDataframeDrop.safeParse(
    normalizeEnv(process.env)[SERVER_ENV.enableDataframeDrop],
  );
  return flag.success && flag.data;
}
