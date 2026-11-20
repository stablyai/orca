import { describe, expect, it } from 'vitest'
import {
  parsePluginLockfile,
  serializePluginLockfile,
  type PluginLockfile
} from '../installation/plugin-install-lockfile'

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
})
