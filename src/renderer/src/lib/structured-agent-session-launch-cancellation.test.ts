// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-types'
import { suppressCancelledStructuredSessionTabs } from '@/runtime/structured-agent-session-tab-retirement'
import type { StructuredLaunchState } from './structured-agent-session-launch-registry'
import {
  hasStructuredAgentSessionLaunchCancellationTombstone,
  markStructuredAgentSessionLaunchCancelled,
  retireAbsentStructuredAgentSessionLaunchCancellationTombstones,
  resetStructuredAgentLaunchRegistryForTests,
  setStructuredLaunchState
} from './structured-agent-session-launch-registry'
import {
  markStructuredAgentLaunchCancellation,
  claimStructuredAgentLaunchCancellationCleanups,
  beginStructuredAgentSessionAuthoritativeInventory
} from './structured-agent-session-launch-cancellation'
import {
  resetStructuredAgentLaunchPersistenceForTests,
  structuredAgentLaunchCancellationBelongsTo
} from './structured-agent-session-launch-persistence'
import { refreshLocalStructuredSessionTabs } from '@/runtime/local-structured-session-tabs-sync'

const WORKTREE_ID = 'repo-1::worktree-1'
const SESSION_ID = 'session-close-race'

function latePublication(): RuntimeMobileSessionTabsResult {
  return {
    worktree: WORKTREE_ID,
    publicationEpoch: 'epoch-late',
    snapshotVersion: 1,
    activeGroupId: 'group-1',
    activeTabId: `agent-session:${SESSION_ID}`,
    activeTabType: 'agent-session',
    tabs: [
      {
        type: 'agent-session',
        id: `agent-session:${SESSION_ID}`,
        title: 'Codex Chat',
        sessionId: SESSION_ID,
        agent: 'codex',
        isActive: true
      }
    ]
  }
}

describe('structured launch cancellation retirement', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    resetStructuredAgentLaunchPersistenceForTests()
    resetStructuredAgentLaunchRegistryForTests()
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        runtime: {
          call: vi.fn().mockResolvedValue({ ok: true, result: {} })
        }
      }
    })
  })

  it('keeps a late publication suppressed until the cancelled launch settles', async () => {
    let resolveLaunch!: (receipt: { sessionId: string; fence: number }) => void
    const launchPromise = new Promise<{ sessionId: string; fence: number }>((resolve) => {
      resolveLaunch = resolve
    })
    setStructuredLaunchState({
      identity: `codex:${WORKTREE_ID}`,
      intent: {
        worktreeId: WORKTREE_ID,
        sessionId: SESSION_ID,
        agent: 'codex',
        target: { kind: 'local' },
        params: {
          envelope: {
            sessionId: SESSION_ID,
            clientOperationId: 'operation-close-race',
            expectedRuntimeFence: null,
            payloadFingerprint: 'fingerprint-close-race'
          },
          worktree: `id:${WORKTREE_ID}`,
          agent: 'codex'
        }
      },
      promptDelivery: 'auto-submit',
      callers: {
        outcome: 'pending',
        entries: new Set(),
        promptDeliveryResults: new Set(),
        onSettled: () => undefined
      },
      promise: launchPromise,
      visibilityUnknown: false,
      cancelled: false,
      selection: { held: {} }
    } satisfies StructuredLaunchState)

    const beforeCancel = beginStructuredAgentSessionAuthoritativeInventory()
    expect(
      retireAbsentStructuredAgentSessionLaunchCancellationTombstones(new Set(), beforeCancel)
    ).toBe(false)
    markStructuredAgentSessionLaunchCancelled(WORKTREE_ID, SESSION_ID)
    const afterCancel = beginStructuredAgentSessionAuthoritativeInventory()
    expect(
      retireAbsentStructuredAgentSessionLaunchCancellationTombstones(new Set(), afterCancel)
    ).toBe(false)
    expect(hasStructuredAgentSessionLaunchCancellationTombstone(WORKTREE_ID, SESSION_ID)).toBe(true)

    resolveLaunch({ sessionId: SESSION_ID, fence: 1 })
    await Promise.resolve()
    const suppressed = suppressCancelledStructuredSessionTabs(latePublication(), { kind: 'local' })
    expect(suppressed.tabs).toEqual([])
    expect(hasStructuredAgentSessionLaunchCancellationTombstone(WORKTREE_ID, SESSION_ID)).toBe(true)
    expect(
      retireAbsentStructuredAgentSessionLaunchCancellationTombstones(new Set(), beforeCancel)
    ).toBe(false)

    const afterSettlement = beginStructuredAgentSessionAuthoritativeInventory()
    expect(
      retireAbsentStructuredAgentSessionLaunchCancellationTombstones(new Set(), afterSettlement)
    ).toBe(true)
    expect(hasStructuredAgentSessionLaunchCancellationTombstone(WORKTREE_ID, SESSION_ID)).toBe(
      false
    )
  })

  it('keeps remote cancellations out of local and other-host inventories', () => {
    const target = {
      kind: 'environment',
      environmentId: 'nexbox',
      expectedEnvironmentPairingRevision: 10
    } as const
    markStructuredAgentLaunchCancellation(SESSION_ID, false, undefined, target)
    const inventory = beginStructuredAgentSessionAuthoritativeInventory()
    expect(
      retireAbsentStructuredAgentSessionLaunchCancellationTombstones(new Set(), inventory)
    ).toBe(false)
    expect(
      retireAbsentStructuredAgentSessionLaunchCancellationTombstones(new Set(), inventory, {
        kind: 'environment',
        environmentId: 'other'
      })
    ).toBe(false)
    expect(
      suppressCancelledStructuredSessionTabs(latePublication(), { kind: 'local' }).tabs
    ).toHaveLength(1)
    expect(
      suppressCancelledStructuredSessionTabs(latePublication(), {
        ...target,
        expectedEnvironmentPairingRevision: 11
      }).tabs
    ).toHaveLength(1)
    expect(
      retireAbsentStructuredAgentSessionLaunchCancellationTombstones(new Set(), inventory, target)
    ).toBe(true)
  })

  it('restores cancellation cleanup only for the original remote pairing', () => {
    const target = {
      kind: 'environment',
      environmentId: 'nexbox',
      expectedEnvironmentPairingRevision: 10
    } as const
    markStructuredAgentLaunchCancellation(SESSION_ID, false, undefined, target)
    resetStructuredAgentLaunchRegistryForTests()
    resetStructuredAgentLaunchPersistenceForTests()
    expect(claimStructuredAgentLaunchCancellationCleanups()).toEqual([])
    expect(
      claimStructuredAgentLaunchCancellationCleanups({
        ...target,
        expectedEnvironmentPairingRevision: 11
      })
    ).toEqual([])
    expect(claimStructuredAgentLaunchCancellationCleanups(target)).toEqual([SESSION_ID])
  })

  it('retains the remote owner when the launch state has already been published', () => {
    const target = {
      kind: 'environment',
      environmentId: 'nexbox',
      expectedEnvironmentPairingRevision: 10
    } as const
    expect(markStructuredAgentSessionLaunchCancelled(WORKTREE_ID, SESSION_ID, target)).toBe(true)
    resetStructuredAgentLaunchRegistryForTests()
    resetStructuredAgentLaunchPersistenceForTests()

    expect(structuredAgentLaunchCancellationBelongsTo(SESSION_ID, { kind: 'local' })).toBe(false)
    expect(structuredAgentLaunchCancellationBelongsTo(SESSION_ID, target)).toBe(true)
    expect(claimStructuredAgentLaunchCancellationCleanups()).toEqual([])
    expect(claimStructuredAgentLaunchCancellationCleanups(target)).toEqual([SESSION_ID])
  })

  it('drains a restored cancellation before a newer inventory retires it', async () => {
    markStructuredAgentSessionLaunchCancelled(WORKTREE_ID, SESSION_ID)
    resetStructuredAgentLaunchRegistryForTests()
    resetStructuredAgentLaunchPersistenceForTests()

    const close = Promise.withResolvers<void>()
    const call = vi.fn(({ method }: { method: string }) => {
      if (method === 'agentSession.close') {
        return close.promise.then(() => ({ ok: true, result: { ok: true } }))
      }
      return Promise.resolve({ ok: true, result: { snapshots: [], authoritative: true } })
    })
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { runtime: { call } }
    })

    await refreshLocalStructuredSessionTabs(undefined, { authoritative: true })

    expect(call.mock.calls.map(([request]) => request.method)).toEqual([
      'agentSession.close',
      'session.tabs.listAll'
    ])
    expect(hasStructuredAgentSessionLaunchCancellationTombstone(WORKTREE_ID, SESSION_ID)).toBe(true)

    // The close shares the host's session lane with create, so settlement drains a late attach.
    close.resolve()
    await close.promise
    await new Promise((resolve) => setTimeout(resolve, 0))
    await refreshLocalStructuredSessionTabs()

    expect(hasStructuredAgentSessionLaunchCancellationTombstone(WORKTREE_ID, SESSION_ID)).toBe(
      false
    )
    expect(
      call.mock.calls.filter(([request]) => request.method === 'agentSession.close')
    ).toHaveLength(1)
  })
})
