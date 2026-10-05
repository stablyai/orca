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
import { beginStructuredAgentSessionAuthoritativeInventory } from './structured-agent-session-launch-cancellation'
import { resetStructuredAgentLaunchPersistenceForTests } from './structured-agent-session-launch-persistence'
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
        executionHostId: 'local',
        target: { kind: 'local' },
        sessionId: SESSION_ID,
        agent: 'codex',
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
        attempt: { kind: 'first', requestId: 'plus-pick', blank: true, stagedEntry: null },
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
      retireAbsentStructuredAgentSessionLaunchCancellationTombstones(
        new Set(),
        beforeCancel,
        'local'
      )
    ).toBe(false)
    markStructuredAgentSessionLaunchCancelled(WORKTREE_ID, SESSION_ID, 'local')
    const afterCancel = beginStructuredAgentSessionAuthoritativeInventory()
    expect(
      retireAbsentStructuredAgentSessionLaunchCancellationTombstones(
        new Set(),
        afterCancel,
        'local'
      )
    ).toBe(false)
    expect(hasStructuredAgentSessionLaunchCancellationTombstone(WORKTREE_ID, SESSION_ID)).toBe(true)

    resolveLaunch({ sessionId: SESSION_ID, fence: 1 })
    await Promise.resolve()
    const suppressed = suppressCancelledStructuredSessionTabs(latePublication(), { kind: 'local' })
    expect(suppressed.tabs).toEqual([])
    expect(hasStructuredAgentSessionLaunchCancellationTombstone(WORKTREE_ID, SESSION_ID)).toBe(true)
    expect(
      retireAbsentStructuredAgentSessionLaunchCancellationTombstones(
        new Set(),
        beforeCancel,
        'local'
      )
    ).toBe(false)

    const afterSettlement = beginStructuredAgentSessionAuthoritativeInventory()
    expect(
      retireAbsentStructuredAgentSessionLaunchCancellationTombstones(
        new Set(),
        afterSettlement,
        'local'
      )
    ).toBe(true)
    expect(hasStructuredAgentSessionLaunchCancellationTombstone(WORKTREE_ID, SESSION_ID)).toBe(
      false
    )
  })

  // A runtime refused its chats answers with no chat rows; that absence is not the host's answer.
  it('keeps a tombstone through an inventory that cannot list chats', async () => {
    setStructuredLaunchState({
      identity: `codex:${WORKTREE_ID}`,
      intent: {
        worktreeId: WORKTREE_ID,
        executionHostId: 'local',
        target: { kind: 'local' },
        sessionId: SESSION_ID,
        agent: 'codex',
        params: {
          envelope: {
            sessionId: SESSION_ID,
            clientOperationId: 'operation-unverifiable',
            expectedRuntimeFence: null,
            payloadFingerprint: 'fingerprint-unverifiable'
          },
          worktree: `id:${WORKTREE_ID}`,
          agent: 'codex'
        }
      },
      promptDelivery: 'auto-submit',
      callers: {
        outcome: 'pending',
        attempt: { kind: 'first', requestId: 'plus-pick', blank: true, stagedEntry: null },
        entries: new Set(),
        promptDeliveryResults: new Set(),
        onSettled: () => undefined
      },
      promise: Promise.resolve({ sessionId: SESSION_ID, fence: 1 }),
      visibilityUnknown: false,
      cancelled: false,
      selection: { held: {} }
    } satisfies StructuredLaunchState)
    markStructuredAgentSessionLaunchCancelled(WORKTREE_ID, SESSION_ID, 'local')
    await new Promise((resolve) => setTimeout(resolve, 0))
    const frame = (unverifiable: boolean): RuntimeMobileSessionTabsResult => ({
      ...latePublication(),
      activeTabId: null,
      activeTabType: null,
      tabs: [],
      ...(unverifiable ? { agentSessionsUnverifiable: true as const } : {})
    })
    const call = vi.fn()
    Object.defineProperty(window, 'api', { configurable: true, value: { runtime: { call } } })

    call.mockResolvedValue({ ok: true, result: { snapshots: [frame(true)], authoritative: true } })
    await refreshLocalStructuredSessionTabs()
    expect(hasStructuredAgentSessionLaunchCancellationTombstone(WORKTREE_ID, SESSION_ID)).toBe(true)

    call.mockResolvedValue({ ok: true, result: { snapshots: [frame(false)], authoritative: true } })
    await refreshLocalStructuredSessionTabs()
    expect(hasStructuredAgentSessionLaunchCancellationTombstone(WORKTREE_ID, SESSION_ID)).toBe(
      false
    )
  })

  it('drains a restored cancellation before a newer inventory retires it', async () => {
    markStructuredAgentSessionLaunchCancelled(WORKTREE_ID, SESSION_ID, 'local')
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
