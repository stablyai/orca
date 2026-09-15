import { describe, expect, it } from 'vitest'
import {
  PLUGIN_COMMAND_LIMIT,
  PLUGIN_ID_MAX_LENGTH,
  parsePluginManifest,
  pluginManifestSchema
} from './plugin-manifest'
import { PLUGIN_UNSCOPED_CAPABILITY_KINDS } from './plugin-capabilities'
import {
  PLUGIN_CAPABILITY_PATH_LIMIT,
  PLUGIN_CAPABILITY_PATH_MAX_LENGTH
} from './plugin-capability-scope'

// Built from code points rather than pasted as raw bytes: an invisible fixture
// survives neither a diff viewer nor a copy-paste.
const RLO = String.fromCharCode(0x202e)
const NUL = String.fromCharCode(0)

function manifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    manifestVersion: 1,
    id: 'demo',
    publisher: 'orca-samples',
    name: 'Demo',
    version: '1.0.0',
    engines: { orca: '>=1.0.0' },
    pluginApi: 1,
    contributes: { panels: [], commands: [], events: [] },
    capabilities: [],
    ...overrides
  }
}

function withCapabilities(...entries: unknown[]): Record<string, unknown> {
  return manifest({ capabilities: entries })
}

describe('pluginManifestSchema boundaries', () => {
  it('accepts documented dotted command namespaces with camel-case actions', () => {
    const result = parsePluginManifest(
      manifest({
        main: 'main.mjs',
        contributes: {
          panels: [],
          commands: [{ id: 'jupyter.restartKernel', title: 'Restart kernel' }],
          events: []
        }
      })
    )

    expect(result).toMatchObject({ ok: true })
  })

  it('rejects oversized identities and invalid semantic versions', () => {
    expect(parsePluginManifest(manifest({ id: 'a'.repeat(PLUGIN_ID_MAX_LENGTH + 1) })).ok).toBe(
      false
    )
    expect(parsePluginManifest(manifest({ version: '01.0.0' })).ok).toBe(false)
    expect(parsePluginManifest(manifest({ version: '1.0' })).ok).toBe(false)
    expect(parsePluginManifest(manifest({ version: '1.0.0-01' })).ok).toBe(false)
    expect(parsePluginManifest(manifest({ version: '1.0.0-alpha.1+build.5' })).ok).toBe(true)
  })

  it('rejects duplicate contribution ids', () => {
    const parsed = pluginManifestSchema.safeParse(
      manifest({
        main: 'main.mjs',
        contributes: {
          panels: [
            { id: 'dashboard', title: 'One', entry: 'one.html' },
            { id: 'dashboard', title: 'Two', entry: 'two.html' }
          ],
          commands: [
            { id: 'run', title: 'One' },
            { id: 'run', title: 'Two' }
          ],
          events: []
        }
      })
    )

    expect(parsed.success).toBe(false)
    if (!parsed.success) {
      expect(parsed.error.issues.map((issue) => issue.message)).toEqual(
        expect.arrayContaining(['duplicate panels id: dashboard', 'duplicate commands id: run'])
      )
    }
  })

  it('caps contribution arrays before they reach renderer or worker registries', () => {
    const commands = Array.from({ length: PLUGIN_COMMAND_LIMIT + 1 }, (_, index) => ({
      id: `command-${index}`,
      title: `Command ${index}`
    }))
    expect(
      parsePluginManifest(
        manifest({
          main: 'main.mjs',
          contributes: { panels: [], commands, events: [] }
        })
      ).ok
    ).toBe(false)
  })
})

describe('pluginManifestSchema capability surface', () => {
  it('rejects a duplicate files:read entry, naming which entry is the duplicate', () => {
    expect(
      parsePluginManifest(
        withCapabilities(
          { kind: 'workspace:read' },
          { kind: 'storage' },
          { kind: 'files:read', paths: ['.planning/**'] },
          { kind: 'files:read', paths: ['docs/**'] }
        )
      )
    ).toEqual({
      ok: false,
      error: 'capabilities.3: duplicate files:read capability; declare all paths in a single entry'
    })
  })

  it('reports every duplicate files:read entry, not only the second', () => {
    const parsed = pluginManifestSchema.safeParse(
      withCapabilities(
        { kind: 'files:read', paths: ['a/**'] },
        { kind: 'files:read', paths: ['b/**'] },
        { kind: 'files:read', paths: ['c/**'] }
      )
    )

    expect(parsed.success).toBe(false)
    if (!parsed.success) {
      expect(
        parsed.error.issues
          .filter((issue) => issue.message.startsWith('duplicate files:read'))
          .map((issue) => issue.path)
      ).toEqual([
        ['capabilities', 1],
        ['capabilities', 2]
      ])
    }
  })

  it('accepts the scoped and unscoped shapes a declared grant can take', () => {
    expect(
      parsePluginManifest(withCapabilities({ kind: 'files:read', paths: ['.planning/**'] })).ok
    ).toBe(true)
    expect(parsePluginManifest(withCapabilities({ kind: 'workspace:list' })).ok).toBe(true)
    expect(parsePluginManifest(withCapabilities({ kind: 'files:read', paths: ['**'] })).ok).toBe(
      true
    )
    // Zero files:read entries, and exactly one declared away from index 0.
    expect(parsePluginManifest(manifest()).ok).toBe(true)
    expect(
      parsePluginManifest(
        withCapabilities({ kind: 'storage' }, { kind: 'files:read', paths: ['docs/**'] })
      ).ok
    ).toBe(true)
  })

  it('accepts a paths list sitting exactly on both budget limits', () => {
    const paths = Array.from(
      { length: PLUGIN_CAPABILITY_PATH_LIMIT },
      (_, index) =>
        `${'a'.repeat(PLUGIN_CAPABILITY_PATH_MAX_LENGTH - 3)}${String(index).padStart(3, '0')}`
    )

    expect(paths.every((path) => path.length === PLUGIN_CAPABILITY_PATH_MAX_LENGTH)).toBe(true)
    expect(parsePluginManifest(withCapabilities({ kind: 'files:read', paths })).ok).toBe(true)
  })

  it.each([
    [
      'files:read declaring no paths at all',
      { kind: 'files:read' },
      'capabilities.0.paths: Invalid input: expected array, received undefined'
    ],
    [
      'an empty paths array',
      { kind: 'files:read', paths: [] },
      'capabilities.0.paths: Too small: expected array to have >=1 items'
    ],
    [
      'an empty-string pattern',
      { kind: 'files:read', paths: [''] },
      'capabilities.0.paths.0: Too small: expected string to have >=1 characters'
    ],
    [
      'paths given as a string rather than an array',
      { kind: 'files:read', paths: '**' },
      'capabilities.0.paths: Invalid input: expected array, received string'
    ],
    [
      'a number inside paths',
      { kind: 'files:read', paths: [1] },
      'capabilities.0.paths.0: Invalid input: expected string, received number'
    ]
  ])('refuses %s with an error naming the fault', (_label, capability, error) => {
    expect(parsePluginManifest(withCapabilities(capability))).toEqual({ ok: false, error })
  })

  it('refuses one pattern past the list budget', () => {
    const paths = Array.from(
      { length: PLUGIN_CAPABILITY_PATH_LIMIT + 1 },
      (_, index) => `dir-${index}/**`
    )

    expect(parsePluginManifest(withCapabilities({ kind: 'files:read', paths }))).toEqual({
      ok: false,
      error: 'capabilities.0.paths: Too big: expected array to have <=32 items'
    })
  })

  it('refuses one character past the pattern-length budget', () => {
    const paths = ['a'.repeat(PLUGIN_CAPABILITY_PATH_MAX_LENGTH + 1)]

    expect(parsePluginManifest(withCapabilities({ kind: 'files:read', paths }))).toEqual({
      ok: false,
      error: 'capabilities.0.paths.0: Too big: expected string to have <=256 characters'
    })
  })

  it('refuses a paths key on every unscoped kind rather than silently ignoring it', () => {
    expect(PLUGIN_UNSCOPED_CAPABILITY_KINDS.length).toBeGreaterThan(0)
    for (const kind of PLUGIN_UNSCOPED_CAPABILITY_KINDS) {
      expect(parsePluginManifest(withCapabilities({ kind, paths: ['**'] }))).toEqual({
        ok: false,
        error: 'capabilities.0: Unrecognized key: "paths"'
      })
    }
  })

  it.each([
    '/etc/passwd',
    '../x',
    'C:\\x',
    '\\\\srv\\share',
    '!foo',
    'a?b',
    'a{b,c}',
    'a[bc]',
    // One representative per rule family added by the 01-05 gap closure, so the new
    // refusals are proven through parsePluginManifest and not only on the predicate.
    '@(a|b)/**',
    'src/!(secret)/**',
    'src/**\\',
    './docs/**',
    `${RLO}dm.*/cod`,
    `src/${NUL}`,
    'src/ '
  ])('refuses the structurally unsafe pattern %j through the manifest schema', (path) => {
    expect(parsePluginManifest(withCapabilities({ kind: 'files:read', paths: [path] })).ok).toBe(
      false
    )
  })

  it('names the offending pattern by the index the author wrote it at', () => {
    // 'zz/**' sorts after '../x', so an index of 1 proves the element refusal ran
    // before the dedupe-and-sort transform could renumber the list.
    const parsed = pluginManifestSchema.safeParse(
      withCapabilities({ kind: 'files:read', paths: ['zz/**', '../x'] })
    )

    expect(parsed.success).toBe(false)
    if (!parsed.success) {
      expect(parsed.error.issues[0]?.path).toEqual(['capabilities', 0, 'paths', 1])
    }
  })

  it('refuses an unknown capability kind', () => {
    expect(parsePluginManifest(withCapabilities({ kind: 'files:write', paths: ['**'] })).ok).toBe(
      false
    )
  })
})
