import { afterEach, describe, expect, it } from 'vitest'
import type { Tab } from '../../../shared/tab-types'
import { replaceRuntimeEnvironmentRevisions } from './runtime-environment-revision'
import {
  stampStructuredTabOwner,
  structuredTabOwnerBinding,
  structuredTabOwnerFromStamp
} from './structured-tab-owner'

function tab(overrides: Partial<Tab> = {}): Tab {
  return {
    id: 'tab-1',
    entityId: 'session-1',
    groupId: 'group-1',
    worktreeId: 'wt-1',
    contentType: 'agent-session',
    label: 'Codex Chat',
    customLabel: null,
    color: null,
    sortOrder: 0,
    createdAt: 0,
    agentSessionAgent: 'codex',
    ...overrides
  }
}

afterEach(() => {
  replaceRuntimeEnvironmentRevisions([])
})

describe('structuredTabOwnerFromStamp', () => {
  it('reads an environment stamp with the revision it was stamped at', () => {
    replaceRuntimeEnvironmentRevisions([{ id: 'env-a', createdAt: 1, pairingRevision: 9 }])
    expect(
      structuredTabOwnerFromStamp(
        tab({ executionHostId: 'runtime:env-a', runtimeOwnerPairingRevision: 4 })
      )
    ).toEqual({ kind: 'environment', environmentId: 'env-a', pairingRevision: 4 })
  })

  it('reads a local stamp, and an ssh host as local because it has no client RPC path', () => {
    expect(structuredTabOwnerFromStamp(tab({ executionHostId: 'local' }))).toEqual({
      kind: 'local'
    })
    expect(structuredTabOwnerFromStamp(tab({ executionHostId: 'ssh:box' }))).toEqual({
      kind: 'local'
    })
  })

  it('returns null for an unstamped tab so the caller keeps the legacy derivation', () => {
    expect(structuredTabOwnerFromStamp(tab())).toBeNull()
  })
})

describe('structuredTabOwnerBinding', () => {
  it('keeps the stamped environment even when the worktree now resolves elsewhere', () => {
    replaceRuntimeEnvironmentRevisions([
      { id: 'env-a', createdAt: 1, pairingRevision: 3 },
      { id: 'env-b', createdAt: 1, pairingRevision: 1 }
    ])
    const binding = structuredTabOwnerBinding(
      tab({ executionHostId: 'runtime:env-a', runtimeOwnerPairingRevision: 3 }),
      'env-b'
    )
    expect(binding.target).toEqual({ kind: 'environment', environmentId: 'env-a' })
    expect(binding.ownerPairingStale).toBe(false)
  })

  it('keeps a local stamp local even when the worktree became runtime-owned', () => {
    replaceRuntimeEnvironmentRevisions([{ id: 'env-b', createdAt: 1, pairingRevision: 1 }])
    const binding = structuredTabOwnerBinding(tab({ executionHostId: 'local' }), 'env-b')
    expect(binding.target).toEqual({ kind: 'local' })
    expect(binding.ownerPairingStale).toBe(false)
  })

  it('reports a re-paired stamped owner as stale instead of rebinding to the new occupant', () => {
    replaceRuntimeEnvironmentRevisions([{ id: 'env-a', createdAt: 1, pairingRevision: 7 }])
    const binding = structuredTabOwnerBinding(
      tab({ executionHostId: 'runtime:env-a', runtimeOwnerPairingRevision: 3 }),
      'env-a'
    )
    expect(binding.ownerPairingStale).toBe(true)
    expect(binding.target).toEqual({ kind: 'environment', environmentId: 'env-a' })
  })

  it('falls back to the worktree runtime for a legacy tab, and never calls it stale', () => {
    replaceRuntimeEnvironmentRevisions([{ id: 'env-b', createdAt: 1, pairingRevision: 5 }])
    expect(structuredTabOwnerBinding(tab(), 'env-b')).toEqual({
      owner: { kind: 'environment', environmentId: 'env-b' },
      target: { kind: 'environment', environmentId: 'env-b' },
      ownerPairingStale: false
    })
    expect(structuredTabOwnerBinding(tab(), null)).toEqual({
      owner: { kind: 'local' },
      target: { kind: 'local' },
      ownerPairingStale: false
    })
  })
})

describe('stampStructuredTabOwner', () => {
  it('captures the publisher host and its current revision for a fresh tab', () => {
    replaceRuntimeEnvironmentRevisions([{ id: 'env-a', createdAt: 1, pairingRevision: 6 }])
    expect(stampStructuredTabOwner(undefined, 'runtime:env-a')).toEqual({
      executionHostId: 'runtime:env-a',
      runtimeOwnerPairingRevision: 6
    })
    expect(stampStructuredTabOwner(undefined, 'local')).toEqual({ executionHostId: 'local' })
  })

  it('pins an already-stamped tab so a re-pair cannot move an open pane', () => {
    replaceRuntimeEnvironmentRevisions([{ id: 'env-a', createdAt: 1, pairingRevision: 9 }])
    expect(
      stampStructuredTabOwner(
        { executionHostId: 'runtime:env-a', runtimeOwnerPairingRevision: 2 },
        'runtime:env-a'
      )
    ).toEqual({ executionHostId: 'runtime:env-a', runtimeOwnerPairingRevision: 2 })
  })
})
