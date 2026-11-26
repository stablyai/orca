// The desktop Move confirmations say what Move does: a new or existing host entry, removal tried for
// eligible copies, and a backup of each settings file before an entry leaves it.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { translate } from '@/i18n/i18n'
import enRuntimeRequired from '@/i18n/en-runtime-required.json'
import en from '@/i18n/locales/en.json'
import { createOrcaI18n } from '../../../../../shared/i18n/orca-i18n-instance'

const LINE =
  "Orca uses a new or existing entry on this host's MCP server list. It tries to remove eligible copies from the settings for {{agents}}. Before removing entries from a settings file, Orca backs up that file."
const ALL_LINE =
  "Orca moves servers one at a time, stopping if one fails. For each server it reaches, it uses a new or existing entry on this host's MCP server list and tries to remove eligible copies from the settings for {{agents}}. Before removing entries from a settings file, Orca backs up that file."
const COPY = [
  ['settings.mcpServers.move.line', LINE, 205],
  ['settings.mcpServers.move.allLine', ALL_LINE, 288]
] as const

const pane = readFileSync(new URL('McpServersPane.tsx', import.meta.url), 'utf8')

/** The string literal passed right after `key` in a t() call, evaluated as TypeScript would. */
function callerDefault(key: string): string {
  const match = new RegExp(
    `'${key.replaceAll('.', '\\.')}',\\s*("(?:[^"\\\\]|\\\\.)*"|'(?:[^'\\\\]|\\\\.)*')`
  ).exec(pane)
  expect(match, `${key} default`).not.toBeNull()
  const literal = match![1]!
  return literal.startsWith('"')
    ? (JSON.parse(literal) as string)
    : (JSON.parse(
        `"${literal.slice(1, -1).replaceAll("\\'", "'").replaceAll('"', '\\"')}"`
      ) as string)
}

const leaf = (catalog: unknown, key: string): unknown =>
  key.split('.').reduce<unknown>((node, part) => (node as Record<string, unknown>)?.[part], catalog)

describe('desktop Move confirmation copy', () => {
  it.each(COPY)('%s: caller default and en.json carry the reviewed text', (key, text, bytes) => {
    expect(callerDefault(key)).toBe(text)
    expect(leaf(en, key)).toBe(text)
    expect(Buffer.byteLength(text, 'utf8')).toBe(bytes)
    expect(text.match(/\{\{[^}]+\}\}/g)).toEqual(['{{agents}}'])
    expect(text).not.toContain('’')
  })

  it.each(COPY)('%s: English shows the caller default, with the agents filled in', (key, text) => {
    // Not in the boot bundle, so English resolves the call site's default (the missing-resource path).
    expect(leaf(enRuntimeRequired, key)).toBeUndefined()
    const agents = 'Codex and Cursor'
    const expected = text.replace('{{agents}}', agents)
    expect(translate(key, callerDefault(key), { agents })).toBe(expected)
    // A build that serves en.json as the English resource shows the same words.
    const withCatalog = createOrcaI18n({ loadCatalog: () => undefined, englishResources: en })
    expect(withCatalog.translate(key, 'unused fallback', { agents })).toBe(expected)
  })
})
