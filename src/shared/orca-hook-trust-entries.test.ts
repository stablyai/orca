import { describe, expect, it } from 'vitest'
import {
  withOrcaHookRepoAlwaysTrusted,
  withOrcaHookScriptConfirmed
} from './orca-hook-trust-entries'
import type { PersistedTrustedOrcaHooks } from './orca-yaml-hook-types'

describe('orca hook trust entries', () => {
  it('preserves unrelated trust entries when confirming a script', () => {
    const trust: PersistedTrustedOrcaHooks = {
      'repo-1': { archive: { contentHash: 'archive-hash', approvedAt: 1000 } }
    }

    expect(withOrcaHookScriptConfirmed(trust, 'repo-1', 'setup', 'setup-hash', 2000)).toEqual({
      'repo-1': {
        archive: { contentHash: 'archive-hash', approvedAt: 1000 },
        setup: { contentHash: 'setup-hash', approvedAt: 2000 }
      }
    })
  })

  it('records always-trust without dropping existing script approvals', () => {
    const trust: PersistedTrustedOrcaHooks = {
      'repo-1': { setup: { contentHash: 'setup-hash', approvedAt: 1000 } }
    }

    expect(withOrcaHookRepoAlwaysTrusted(trust, 'repo-1', 2000)).toEqual({
      'repo-1': {
        setup: { contentHash: 'setup-hash', approvedAt: 1000 },
        all: { approvedAt: 2000 }
      }
    })
  })
})
