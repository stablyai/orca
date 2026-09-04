import { describe, expect, it } from 'vitest'
import { canonicalizeCapabilitySet, type PluginCapability } from './plugin-capabilities'
import { fingerprintPluginConsent } from './plugin-consent-fingerprint'
import {
  getPluginActivationState,
  needsReconsent,
  normalizePluginConsents
} from './plugin-consent-state'
import {
  parsePluginLockfile,
  serializePluginLockfile,
  type PluginLockfile
} from './plugin-install-lockfile'
import { pluginManifestSchema } from './plugin-manifest'

const workspaceRead: PluginCapability = { kind: 'workspace:read' }
const storage: PluginCapability = { kind: 'storage' }

// Why raw rather than pre-parsed: the dedupe-and-sort of a scoped grant's globs lives in
// the schema transform, so every scope fixture below must go through
// `pluginManifestSchema.parse` at its own call site; a hand-built literal skips the
// transform and would assert nothing about the property it claims to prove (D-06, D-07).
function manifestDeclaring(capabilities: readonly unknown[]): Record<string, unknown> {
  return {
    manifestVersion: 1,
    id: 'demo',
    publisher: 'orca-samples',
    name: 'Demo',
    version: '1.0.0',
    engines: { orca: '>=1.0.0' },
    pluginApi: 1,
    contributes: { panels: [], commands: [], events: [] },
    capabilities
  }
}

describe('fingerprintPluginConsent', () => {
  it('drops malformed persisted consent identities and oversized fingerprints', () => {
    expect(
      normalizePluginConsents({
        __proto__: 'polluted',
        constructor: 'polluted',
        invalid: 'sha256-invalid',
        'orca-samples.demo': 'sha256-valid',
        'orca-samples.large': 'x'.repeat(257)
      })
    ).toEqual({ 'orca-samples.demo': 'sha256-valid' })
  })

  it('is stable across capability order and duplicate declarations', () => {
    const first = fingerprintPluginConsent({
      main: undefined,
      capabilities: [workspaceRead, storage, workspaceRead]
    })
    const second = fingerprintPluginConsent({
      main: undefined,
      capabilities: [storage, workspaceRead]
    })

    expect(first).toBe(second)
  })

  it('changes when a panel-only plugin gains a trusted Node worker', () => {
    const panelOnly = fingerprintPluginConsent({ main: undefined, capabilities: [] })
    const withWorker = fingerprintPluginConsent({ main: 'worker.js', capabilities: [] })

    expect(withWorker).not.toBe(panelOnly)
    const lists = {
      pluginConsents: { 'orca-samples.demo': panelOnly },
      disabledPlugins: []
    }
    expect(getPluginActivationState('orca-samples.demo', withWorker, lists)).toBe('pending')
    expect(needsReconsent('orca-samples.demo', withWorker, lists)).toBe(true)
  })

  it('preserves capability-only fingerprints for existing panel plugins', () => {
    // Why: this test used to build its expected value by calling
    // canonicalizeCapabilitySet, the function whose output it was checking, so an
    // encoding change moved both sides together and it stayed green through the exact
    // regression it exists to catch. Every expectation below is a hard-coded literal.
    expect(
      fingerprintPluginConsent({ main: undefined, capabilities: [workspaceRead, storage] })
    ).toBe('sha256-lKZPtWla+uf0K1ShSl76ExwU+oWrEj/DX8DMsVoLOyY=')

    expect(
      fingerprintPluginConsent({
        main: undefined,
        capabilities: [
          { kind: 'workspace:read' },
          { kind: 'terminal:send' },
          { kind: 'notifications:show' },
          { kind: 'storage' },
          { kind: 'secrets' },
          { kind: 'events:subscribe' },
          { kind: 'settings:own' }
        ]
      })
    ).toBe('sha256-zwcMsV+9xzG/7d1CNIa0kUTt2Vy8CI4cKNSAuqs2w4I=')

    expect(fingerprintPluginConsent({ main: undefined, capabilities: [] })).toBe(
      'sha256-T1PNoYwrqgwDVLtfmj7L5e0Sq02OEbqHPC8RFhICuUU='
    )
  })

  it('preserves the canonical encoding of the seven pre-existing capabilities', () => {
    expect(
      canonicalizeCapabilitySet([
        { kind: 'workspace:read' },
        { kind: 'terminal:send' },
        { kind: 'notifications:show' },
        { kind: 'storage' },
        { kind: 'secrets' },
        { kind: 'events:subscribe' },
        { kind: 'settings:own' }
      ])
    ).toBe(
      '["{\\"kind\\":\\"events:subscribe\\"}","{\\"kind\\":\\"notifications:show\\"}","{\\"kind\\":\\"secrets\\"}","{\\"kind\\":\\"settings:own\\"}","{\\"kind\\":\\"storage\\"}","{\\"kind\\":\\"terminal:send\\"}","{\\"kind\\":\\"workspace:read\\"}"]'
    )
  })

  it('requires re-consent when instructional content bytes change', () => {
    const subject = {
      main: undefined,
      capabilities: [],
      contributes: {
        keybindings: [],
        vmRecipes: [{ path: 'recipes/cloud.json' }],
        agents: []
      }
    }
    const first = fingerprintPluginConsent(subject, 'a'.repeat(64))
    const second = fingerprintPluginConsent(subject, 'b'.repeat(64))

    expect(second).not.toBe(first)
    expect(
      getPluginActivationState('orca-samples.recipes', second, {
        pluginConsents: { 'orca-samples.recipes': first },
        disabledPlugins: []
      })
    ).toBe('pending')
  })

  it('does not invalidate inert content consent when only its content hash changes', () => {
    const subject = {
      main: undefined,
      capabilities: [],
      contributes: {
        keybindings: [],
        vmRecipes: [],
        agents: []
      }
    }

    expect(fingerprintPluginConsent(subject, 'a'.repeat(64))).toBe(
      fingerprintPluginConsent(subject, 'b'.repeat(64))
    )
  })
})

describe('declared glob scope consent stability', () => {
  it('is stable across glob order and duplicate globs', () => {
    const shuffled = pluginManifestSchema.parse(
      manifestDeclaring([
        { kind: 'files:read', paths: ['src/**', '*.md', '.planning/**', 'src/**'] },
        { kind: 'workspace:list' }
      ])
    )
    const canonical = pluginManifestSchema.parse(
      manifestDeclaring([
        { kind: 'workspace:list' },
        { kind: 'files:read', paths: ['*.md', '.planning/**', 'src/**'] }
      ])
    )

    expect(fingerprintPluginConsent(shuffled)).toBe(fingerprintPluginConsent(canonical))
  })

  it('canonicalises globs in code-unit order rather than locale collation', () => {
    // Why this exact pair: localeCompare puts '.planning/**' first, code-unit order puts
    // '*.md' first. Locale collation is ICU-build-dependent, and Orca ships Electron builds
    // and Node runners whose ICU differs — a fingerprint built on it can change between
    // machines and drop a plugin nobody touched to pending.
    const parsed = pluginManifestSchema.parse(
      manifestDeclaring([{ kind: 'files:read', paths: ['.planning/**', '*.md'] }])
    )

    expect(parsed.capabilities).toEqual([{ kind: 'files:read', paths: ['*.md', '.planning/**'] }])
  })

  it('is a fixed point, so re-parsing a parsed manifest does not move the fingerprint', () => {
    const once = pluginManifestSchema.parse(
      manifestDeclaring([{ kind: 'files:read', paths: ['src/**', '.planning/**', 'src/**'] }])
    )
    const twice = pluginManifestSchema.parse(once)

    expect(fingerprintPluginConsent(twice)).toBe(fingerprintPluginConsent(once))
  })
})

const SCOPE_TRANSITIONS = [
  {
    change: 'widening',
    before: ['.planning/**'],
    after: ['.planning/**', 'src/**'],
    activationState: 'pending',
    reconsent: true
  },
  {
    change: 'narrowing',
    before: ['.planning/**', 'src/**'],
    after: ['.planning/**'],
    activationState: 'pending',
    reconsent: true
  },
  {
    change: 'lateral replacement',
    before: ['.planning/**'],
    after: ['docs/**'],
    activationState: 'pending',
    reconsent: true
  },
  {
    change: 'reordering',
    before: ['.planning/**', 'src/**'],
    after: ['src/**', '.planning/**'],
    activationState: 'approved',
    reconsent: false
  },
  {
    change: 'duplicate normalization',
    before: ['.planning/**', 'src/**'],
    after: ['src/**', '.planning/**', 'src/**'],
    activationState: 'approved',
    reconsent: false
  }
] as const

describe('declared glob scope change detection', () => {
  it.each(SCOPE_TRANSITIONS)(
    'derives the recorded consent state after $change',
    ({ before, after, activationState, reconsent }) => {
      const fingerprintDeclaring = (paths: readonly string[]): string =>
        fingerprintPluginConsent(
          pluginManifestSchema.parse(manifestDeclaring([{ kind: 'files:read', paths: [...paths] }]))
        )
      const recorded = fingerprintDeclaring(before)
      const current = fingerprintDeclaring(after)

      expect(current === recorded).toBe(!reconsent)
      const lists = {
        pluginConsents: { 'orca-samples.demo': recorded },
        disabledPlugins: []
      }
      expect(getPluginActivationState('orca-samples.demo', current, lists)).toBe(activationState)
      expect(needsReconsent('orca-samples.demo', current, lists)).toBe(reconsent)
    }
  )

  it('has no empty-scope grant that could collide with an unscoped kind', () => {
    // The narrowest expressible files:read grant is one pattern, so narrowing bottoms out
    // at a fingerprint that is still distinct from any unscoped kind's encoding.
    expect(
      pluginManifestSchema.safeParse(manifestDeclaring([{ kind: 'files:read', paths: [] }])).success
    ).toBe(false)
  })
})

describe('plugin install lockfile consent fingerprints', () => {
  const persistedEntry = {
    pluginKey: 'orca-samples.demo',
    version: '1.0.0',
    source: { kind: 'local-path' as const, path: '/plugins/demo' },
    resolvedCommit: null,
    contentHash: '0123456789abcdef0123456789abcdef',
    capabilityHash: 'sha256-legacy-name',
    installedAt: 1
  }

  it('reads the legacy capabilityHash field as a consent fingerprint', () => {
    const parsed = parsePluginLockfile({
      version: 1,
      plugins: { 'orca-samples.demo': persistedEntry }
    })

    expect(parsed.plugins['orca-samples.demo']?.consentFingerprint).toBe('sha256-legacy-name')
  })

  it('keeps writing the v1 field name for rollback compatibility', () => {
    const lock: PluginLockfile = {
      version: 1,
      plugins: {
        'orca-samples.demo': {
          ...persistedEntry,
          consentFingerprint: 'sha256-current'
        }
      }
    }

    expect(serializePluginLockfile(lock)).toMatchObject({
      version: 1,
      plugins: {
        'orca-samples.demo': {
          capabilityHash: 'sha256-current'
        }
      }
    })
    expect(
      (serializePluginLockfile(lock) as { plugins: Record<string, unknown> }).plugins[
        'orca-samples.demo'
      ]
    ).not.toHaveProperty('consentFingerprint')
  })

  it('drops a lockfile whose record key disagrees with its embedded identity', () => {
    const parsed = parsePluginLockfile({
      version: 1,
      plugins: {
        'orca-samples.other': persistedEntry
      }
    })

    expect(parsed.plugins).toEqual({})
  })

  it('accepts SHA-256 Git object ids in lockfile provenance', () => {
    const parsed = parsePluginLockfile({
      version: 1,
      plugins: {
        'orca-samples.demo': { ...persistedEntry, resolvedCommit: 'a'.repeat(64) }
      }
    })

    expect(parsed.plugins['orca-samples.demo']?.resolvedCommit).toBe('a'.repeat(64))
  })
})
