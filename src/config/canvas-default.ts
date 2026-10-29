/**
 * @fileoverview Defaults DataCanvas on. The entry point imports this module
 * first: the dataframe tool gates read CANVAS_PROVIDER_TYPE while their modules
 * load, so the default has to be in place before any of them is evaluated.
 * Set CANVAS_PROVIDER_TYPE=none to disable DataCanvas.
 *
 * `./.env` is loaded here the way the framework loads it on its first config
 * parse (never overriding a variable already set), so a value set there wins
 * over the default. Nothing is validated here: `createApp()` parses the
 * framework config and reports an invalid variable with its startup banner.
 * @module config/canvas-default
 */

import { normalizeEnv } from '@cyanheads/mcp-ts-core/config';

try {
  process.loadEnvFile();
} catch (error) {
  // No .env in the working directory is the normal case.
  if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
}

if (normalizeEnv(process.env).CANVAS_PROVIDER_TYPE === undefined) {
  process.env.CANVAS_PROVIDER_TYPE = 'duckdb';
}
