import { createHash } from 'node:crypto'
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

const workspaceRead: PluginCapability = { kind: 'workspace:read' }
const storage: PluginCapability = { kind: 'storage' }

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
    const capabilities = [workspaceRead, storage]
    const legacy = `sha256-${createHash('sha256')
      .update(canonicalizeCapabilitySet(capabilities))
      .digest('base64')}`

    expect(fingerprintPluginConsent({ main: undefined, capabilities })).toBe(legacy)
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
