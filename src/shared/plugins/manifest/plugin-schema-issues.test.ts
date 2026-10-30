import { describe, expect, it } from 'vitest'
import { PLUGIN_MANIFEST_V2_SINCE } from './plugin-schema-field-docs'
import { parsePluginManifest } from './plugin-manifest'
import { pluginSchemaIssueLines } from './plugin-schema-issues'

function v2Manifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    manifestVersion: 2,
    execution: 'data',
    id: 'demo',
    publisher: 'acme',
    name: 'Demo',
    version: '1.0.0',
    engines: { orca: `>=${PLUGIN_MANIFEST_V2_SINCE}` },
    ...overrides
  }
}

function manifestError(raw: unknown): string {
  const parsed = parsePluginManifest(raw)
  if (parsed.ok) {
    throw new Error('expected the manifest to be rejected')
  }
  return parsed.error
}

describe('plugin schema issues', () => {
  it('reports every mistake in one pass with author-facing wording', () => {
    const error = manifestError(
      v2Manifest({
        name: undefined,
        execution: 'root',
        surprise: true,
        contributes: {
          themes: [{ id: 'dusk', title: '', path: 'themes/dusk.json' }],
          syntaxes: Array.from({ length: 17 }, (_, index) => ({
            id: `lang-${index}`,
            title: 'Lang',
            scopeName: 'source.lang',
            path: 'lang.json'
          }))
        }
      })
    )
    expect(error.split('; ')).toEqual([
      'execution: must be one of "data", "declarative", "sandboxed-ui", "trusted-worker"',
      'name: is required',
      'contributes.themes[0].title: must not be empty',
      'contributes.syntaxes: must be at most 16 items',
      '(root): unknown key "surprise"'
    ])
  })

  it('dedupes identical lines and caps the count', () => {
    const issue = (index: number) => ({
      code: 'custom' as const,
      path: ['items', index],
      message: 'bad',
      input: undefined
    })
    const lines = pluginSchemaIssueLines(
      [issue(0), issue(0), ...Array.from({ length: 10 }, (_, index) => issue(index + 1))],
      {},
      3
    )
    expect(lines).toEqual(['items[0]: bad', 'items[1]: bad', 'items[2]: bad', '(8 more)'])
  })

  it('bounds unknown-key lists and line length', () => {
    const keys = Object.fromEntries(
      Array.from({ length: 40 }, (_, index) => [`extra${index}${'x'.repeat(60)}`, true])
    )
    const error = manifestError(v2Manifest(keys))
    expect(error).toMatch(/and 35 more|…$/)
    expect(error.length).toBeLessThanOrEqual(200)
    const short = manifestError(v2Manifest({ a: 1, b: 2, c: 3, d: 4, e: 5, f: 6, g: 7 }))
    expect(short).toBe('(root): unknown keys "a", "b", "c", "d", "e" and 2 more')
  })

  it('tells a missing field from a mistyped one by the input, not the message wording', () => {
    expect(manifestError(v2Manifest({ name: undefined }))).toBe('name: is required')
    expect(manifestError(v2Manifest({ name: 5 }))).toBe('name: must be a string')
    expect(manifestError(v2Manifest({ engines: {} }))).toBe('engines.orca: is required')
    expect(manifestError(v2Manifest({ engines: 'soon' }))).toBe('engines: must be an object')
  })
})
