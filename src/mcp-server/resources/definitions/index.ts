/**
 * @fileoverview Barrel export for all IMF MCP resource definitions.
 * @module mcp-server/resources/definitions/index
 */

export { imfDatabaseResource } from './imf-database.resource.js';

import { imfDatabaseResource } from './imf-database.resource.js';

export const allResourceDefinitions = [imfDatabaseResource];
