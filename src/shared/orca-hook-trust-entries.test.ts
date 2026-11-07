import { describe, expect, it } from 'vitest'
import {
  approvedOrcaHookContentHashes,
  MAX_APPROVED_ORCA_HOOK_HASHES,
  withOrcaHookScriptConfirmed
} from './orca-hook-trust-entries'
import type { PersistedTrustedOrcaHooks } from './orca-yaml-hook-types'

describe('approved setup hash history', () => {
  it('keeps the latest approvals up to the cap, newest first', () => {
    let trust: PersistedTrustedOrcaHooks = {}
    const hashes = Array.from({ length: MAX_APPROVED_ORCA_HOOK_HASHES + 3 }, (_, i) => `hash-${i}`)
    for (const hash of hashes) {
      trust = withOrcaHookScriptConfirmed(trust, 'repo', 'setup', hash, 1)
    }

    const approved = approvedOrcaHookContentHashes(trust, 'repo', 'setup')
    expect(MAX_APPROVED_ORCA_HOOK_HASHES).toBe(20)
    expect(approved).toHaveLength(MAX_APPROVED_ORCA_HOOK_HASHES)
    expect(approved[0]).toBe(hashes.at(-1))
    expect(approved).not.toContain('hash-0')
  })

  it('moves a re-approved older script to the front without duplicating it', () => {
    let trust: PersistedTrustedOrcaHooks = {}
    for (const hash of ['a', 'b', 'c', 'a']) {
      trust = withOrcaHookScriptConfirmed(trust, 'repo', 'setup', hash, 1)
    }
    expect(approvedOrcaHookContentHashes(trust, 'repo', 'setup')).toEqual(['a', 'c', 'b'])
  })
})
