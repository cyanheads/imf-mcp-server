/**
 * @fileoverview The `.mcpb` cleaner and the packaging check select the same
 * dependency agent docs: package-root `skills/`-style trees go, while the MCP
 * SDK's Skills extension runtime under `dist/ext/skills/` stays, since a bundle
 * without it fails at boot (cyanheads/mcp-ts-core#794).
 * @module tests/scripts/bundle-agent-docs.test
 */

import { readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  AGENT_DOC_ENTRY as CLEANER_AGENT_DOC_ENTRY,
  filterAgentDocEntries,
} from '../../scripts/clean-mcpb.js';

interface LintPackaging {
  AGENT_DOC_ENTRY: RegExp;
  checkBundleEntries(entries: string[], bundleLabel: string): string[];
}

/**
 * Loaded by URL at run time: the shipped script's repo-only fallback import
 * does not resolve in a server, so a static import would put it in front of
 * `tsc` (cyanheads/mcp-ts-core#797).
 */
let lint: LintPackaging;
beforeAll(async () => {
  lint = (await import(
    new URL('../../scripts/lint-packaging.ts', import.meta.url).href
  )) as LintPackaging;
});

/** Every file the installed SDK package ships under `dist/ext/skills/`, as bundle entries. */
function installedSdkSkillsRuntime(pkg: 'core' | 'server'): string[] {
  const projectRoot = fileURLToPath(new URL('../../', import.meta.url));
  return readdirSync(
    join(projectRoot, `node_modules/@modelcontextprotocol/${pkg}/dist/ext/skills`),
    {
      recursive: true,
      withFileTypes: true,
    },
  )
    .filter((entry) => entry.isFile())
    .map((entry) => relative(projectRoot, join(entry.parentPath, entry.name)).replaceAll(sep, '/'));
}

const SDK_RUNTIME = [
  'node_modules/@modelcontextprotocol/server/dist/ext/skills/index.mjs',
  'node_modules/@modelcontextprotocol/core/dist/ext/skills/index.mjs',
  'node_modules/some-dep/node_modules/@modelcontextprotocol/server/dist/ext/skills/index.mjs',
  'node_modules/@scope/dep/node_modules/@modelcontextprotocol/core/dist/ext/skills/loader.mjs',
  // A package whose own name is `skills` is a package, not an agent-doc tree.
  'node_modules/@acme/skills/index.js',
  'node_modules/@acme/skills/package.json',
];

const PACKAGE_ROOT_DOCS = [
  'node_modules/dotenv/skills/dotenv/SKILL.md',
  'node_modules/dotenv/skills/dotenv/references/usage.md',
  'node_modules/@cyanheads/mcp-ts-core/framework-skills/add-tool/SKILL.md',
  'node_modules/@scope/pkg/skills/guide/README.md',
  'node_modules/pkg/.claude/settings.json',
  'node_modules/pkg/.agents/skills/x/SKILL.md',
  'node_modules/outer/node_modules/@scope/inner/skills/guide/SKILL.md',
  'node_modules/outer/node_modules/inner/.claude/notes.md',
  'node_modules/pkg/docs/agent/SKILL.md',
];

describe('bundle agent-doc selection', () => {
  it('uses the same matcher in the cleaner and the packaging check', () => {
    expect(lint.AGENT_DOC_ENTRY.source).toBe(CLEANER_AGENT_DOC_ENTRY.source);
    expect(lint.AGENT_DOC_ENTRY.flags).toBe(CLEANER_AGENT_DOC_ENTRY.flags);
  });

  it("keeps every file of the installed SDK's dist/ext/skills/ runtime", () => {
    const runtime = [...installedSdkSkillsRuntime('server'), ...installedSdkSkillsRuntime('core')];
    expect(runtime.length).toBeGreaterThan(0);
    expect(filterAgentDocEntries(runtime)).toEqual([]);
    expect(lint.checkBundleEntries(runtime, 'bundle')).toEqual([]);
  });

  it('keeps nested runtime skills/ modules and packages named skills', () => {
    expect(filterAgentDocEntries(SDK_RUNTIME)).toEqual([]);
    expect(lint.checkBundleEntries(SDK_RUNTIME, 'bundle')).toEqual([]);
  });

  it('strips agent-doc trees at a package root, scoped and nested included', () => {
    expect(filterAgentDocEntries([...SDK_RUNTIME, ...PACKAGE_ROOT_DOCS])).toEqual(
      PACKAGE_ROOT_DOCS,
    );
  });

  it('fails the packaging check while a package-root agent-doc tree remains', () => {
    const errors = lint.checkBundleEntries(
      [...SDK_RUNTIME, 'node_modules/dotenv/skills/dotenv/SKILL.md'],
      'bundle',
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('1 node_modules agent-doc entries');
    expect(errors[0]).toContain('node_modules/dotenv/skills/dotenv/SKILL.md');
  });

  it('never selects the root skills/ tree a server publishes', () => {
    expect(filterAgentDocEntries(['skills/imf-guide/SKILL.md', 'dist/index.js'])).toEqual([]);
  });
});
