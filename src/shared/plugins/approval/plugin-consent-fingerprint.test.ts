import { describe, expect, it } from 'vitest'
import type { PluginCapability } from '../capabilities/plugin-capabilities'
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
} from '../installation/plugin-install-lockfile'

const workspaceRead: PluginCapability = { kind: 'workspace:read' }
const storage: PluginCapability = { kind: 'storage:own' }

describe('fingerprintPluginConsent', () => {
  it('drops malformed persisted consent identities and oversized fingerprints', () => {
    expect(
      normalizePluginConsents({
        __proto__: 'polluted',
        constructor: 'polluted',
        invalid: 'sha256-invalid',
        'samples.demo': 'sha256-valid',
        'samples.large': 'x'.repeat(257)
      })
    ).toEqual({ 'samples.demo': 'sha256-valid' })
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
      pluginConsents: { 'samples.demo': panelOnly },
      disabledPlugins: []
    }
    expect(getPluginActivationState('samples.demo', withWorker, lists)).toBe('pending')
    expect(needsReconsent('samples.demo', withWorker, lists)).toBe(true)
  })

  it('requires re-consent when declarative content bytes change', () => {
    const subject = {
      main: undefined,
      capabilities: [],
      contributes: {
        keybindings: [],
        vmRecipes: [{ path: 'recipes/cloud.json' }],
        agentHarnesses: []
      }
    }
    const first = fingerprintPluginConsent(subject, 'a'.repeat(64))
    const second = fingerprintPluginConsent(subject, 'b'.repeat(64))

    expect(second).not.toBe(first)
    expect(
      getPluginActivationState('samples.recipes', second, {
        pluginConsents: { 'samples.recipes': first },
        disabledPlugins: []
      })
    ).toBe('pending')
  })

  it.each([
    ['a v2 panel', { execution: 'sandboxed-ui' as const, capabilities: [] }],
    ['a v2 worker', { execution: 'trusted-worker' as const, main: 'worker.js', capabilities: [] }],
    ['a v1 worker', { main: 'worker.js', capabilities: [] }],
    [
      'a v1 panel',
      { capabilities: [], contributes: { panels: [{ id: 'p', title: 'P', entry: 'p.html' }] } }
    ]
  ])('binds %s approval to exact package bytes', (_label, subject) => {
    const approved = fingerprintPluginConsent(subject, 'a'.repeat(64))
    const updated = fingerprintPluginConsent(subject, 'b'.repeat(64))

    expect(updated).not.toBe(approved)
    expect(
      needsReconsent('samples.demo', updated, {
        pluginConsents: { 'samples.demo': approved },
        disabledPlugins: []
      })
    ).toBe(true)
  })

  it('requires re-approval when an update adds a capability', () => {
    const lists = (approved: string) => ({
      pluginConsents: { 'samples.demo': approved },
      disabledPlugins: []
    })
    for (const execution of ['data', 'sandboxed-ui', 'trusted-worker'] as const) {
      const main = execution === 'trusted-worker' ? 'worker.js' : undefined
      const approved = fingerprintPluginConsent(
        { execution, main, capabilities: [] },
        'a'.repeat(64)
      )
      const updated = fingerprintPluginConsent(
        { execution, main, capabilities: [storage] },
        'a'.repeat(64)
      )
      expect(needsReconsent('samples.demo', updated, lists(approved)), execution).toBe(true)
    }
  })

  it('requires re-approval whenever an update changes the execution profile', () => {
    const profiles = ['data', 'declarative', 'sandboxed-ui', 'trusted-worker'] as const
    const fingerprintFor = (execution: (typeof profiles)[number]) =>
      fingerprintPluginConsent(
        {
          execution,
          main: execution === 'trusted-worker' ? 'worker.js' : undefined,
          capabilities: [],
          // Alias commands only: nothing that binds bytes, so only the profile differs.
          contributes: {}
        },
        'a'.repeat(64)
      )
    for (const from of profiles) {
      for (const to of profiles.filter((profile) => profile !== from)) {
        expect(
          needsReconsent('samples.demo', fingerprintFor(to), {
            pluginConsents: { 'samples.demo': fingerprintFor(from) },
            disabledPlugins: []
          }),
          `${from} -> ${to}`
        ).toBe(true)
      }
    }
  })

  it('keeps data pack consent stable across byte changes', () => {
    const subject = { execution: 'data' as const, capabilities: [] }
    expect(fingerprintPluginConsent(subject, 'a'.repeat(64))).toBe(
      fingerprintPluginConsent(subject, 'b'.repeat(64))
    )
  })

  it('does not invalidate inert content consent when only its content hash changes', () => {
    const subject = {
      main: undefined,
      capabilities: [],
      contributes: {
        keybindings: [],
        vmRecipes: [],
        agentHarnesses: []
      }
    }

    expect(fingerprintPluginConsent(subject, 'a'.repeat(64))).toBe(
      fingerprintPluginConsent(subject, 'b'.repeat(64))
    )
  })
})

describe('plugin install lockfile consent fingerprints', () => {
  const persistedEntry = {
    pluginKey: 'samples.demo',
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
      plugins: { 'samples.demo': persistedEntry }
    })

    expect(parsed.plugins['samples.demo']?.consentFingerprint).toBe('sha256-legacy-name')
  })

  it('keeps writing the v1 field name for rollback compatibility', () => {
    const lock: PluginLockfile = {
      version: 1,
      plugins: {
        'samples.demo': {
          ...persistedEntry,
          consentFingerprint: 'sha256-current'
        }
      }
    }

    expect(serializePluginLockfile(lock)).toMatchObject({
      version: 1,
      plugins: {
        'samples.demo': {
          capabilityHash: 'sha256-current'
        }
      }
    })
    expect(
      (serializePluginLockfile(lock) as { plugins: Record<string, unknown> }).plugins[
        'samples.demo'
      ]
    ).not.toHaveProperty('consentFingerprint')
  })

  it('drops a lockfile whose record key disagrees with its embedded identity', () => {
    const parsed = parsePluginLockfile({
      version: 1,
      plugins: {
        'samples.other': persistedEntry
      }
    })

    expect(parsed.plugins).toEqual({})
  })

  it('accepts SHA-256 Git object ids in lockfile provenance', () => {
    const parsed = parsePluginLockfile({
      version: 1,
      plugins: {
        'samples.demo': { ...persistedEntry, resolvedCommit: 'a'.repeat(64) }
      }
    })

    expect(parsed.plugins['samples.demo']?.resolvedCommit).toBe('a'.repeat(64))
  })
})
