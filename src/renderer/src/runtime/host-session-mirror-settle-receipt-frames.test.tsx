// @vitest-environment happy-dom

import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-types'
import type * as WebRuntimeTerminalCreationModule from './web-runtime-terminal-creation'
import type * as WebSessionTerminalHandleEventsModule from './web-session-terminal-handle-events'

vi.mock('./web-session-terminal-handle-events', async (importOriginal) => {
  const actual = await importOriginal<typeof WebSessionTerminalHandleEventsModule>()
  const { frameOrderingMocks } = await import('./host-session-mirror-frame-fixtures')
  return {
    ...actual,
    queueAcceptedWebSessionTerminalSnapshot: frameOrderingMocks.queueAcceptedSnapshot
  }
})

vi.mock('./use-runtime-session-mirror-environment-key', async () => {
  const { frameOrderingMocks } = await import('./host-session-mirror-frame-fixtures')
  return {
    useRuntimeSessionMirrorEnvironmentKeys: () => ({
      environmentKey: frameOrderingMocks.runtimeSessionMirrorEnvironmentKey(),
      resubscribeSignal: ''
    })
  }
})

vi.mock('./web-session-terminal-orphan-recovery', async () => {
  const { frameOrderingMocks } = await import('./host-session-mirror-frame-fixtures')
  return { recoverWebSessionTerminalOrphansBeforeApply: frameOrderingMocks.recoverSnapshot }
})

vi.mock('./web-runtime-terminal-creation', async (importOriginal) => {
  const actual = await importOriginal<typeof WebRuntimeTerminalCreationModule>()
  const { frameOrderingMocks } = await import('./host-session-mirror-frame-fixtures')
  return { ...actual, createWebRuntimeSessionTerminal: frameOrderingMocks.createTerminal }
})

import { useAppStore } from '@/store'
import { resumeSleepingAgentSessionsForWorktree } from '@/lib/resume-sleeping-agent-session'
import {
  BG_MIRROR_TAB_ID,
  BG_WT,
  ENV,
  FLOATING_HOST_PARENT_TAB_ID,
  FLOATING_HOST_SURFACE_ID,
  frameOrderingMocks as mocks,
  HOST_PARENT_TAB_ID,
  HOST_SURFACE_ID,
  LEAF_ID,
  MIRROR_TAB_ID,
  makeHostSnapshot,
  makePtylessHostSnapshot,
  OTHER_HOST_PARENT_TAB_ID,
  OTHER_HOST_SURFACE_ID,
  WT
} from './host-session-mirror-frame-fixtures'
import {
  expectHostOwnedRecordNotResumed,
  findSubscription,
  installFrameOrderingHarness,
  publish,
  runtimeCall,
  seedSleepingRecord,
  settle,
  setDocumentVisibility,
  tabIds
} from './host-session-mirror-frame-ordering-test-harness'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../shared/constants'
import {
  clearHostSessionMirrorHydration,
  hasHostSessionMirrorHydrated
} from './host-session-mirror-hydration'
import { refreshWebRuntimeSessionTabsSnapshot } from './web-runtime-session-snapshot'
import { clearWebSessionTabsTrackingForEnvironment } from './web-session-tabs-sync/tracking-lifecycle'
import { useWebSessionTabsSync } from './web-session-tabs-sync/use-web-session-tabs-sync'
import { WEB_SESSION_TABS_VISIBILITY_RESUME_STAGGER_MS } from './web-session-tabs-sync/state'
import { WINDOW_VISIBILITY_SUBSCRIPTION_PARK_DELAY_MS } from './window-visibility-subscription-parking'

/**
 * The receipt era of the same seam: a settle exists only as the proof of a
 * landed patch, or as the rejection an already-accepted view backs.
 */
describe('a global singular frame whose patch never lands', () => {
  installFrameOrderingHarness()

  it('settles nothing until a later frame reaches the store', async () => {
    renderHook(() => useWebSessionTabsSync())
    await act(settle)
    const paneKey = seedSleepingRecord(MIRROR_TAB_ID, WT, 'codex-session-patch-throw')
    expect(resumeSleepingAgentSessionsForWorktree(WT)).toBe(0)

    // Acceptance bookkeeping fails before patch commit; nothing landed, so nothing settles.
    mocks.queueAcceptedSnapshot.mockImplementation(() => {
      throw new Error('accepted-handle queue failed')
    })
    await publish(findSubscription('session.tabs.subscribeAll'), {
      type: 'snapshot',
      ...makeHostSnapshot(WT, OTHER_HOST_SURFACE_ID, OTHER_HOST_PARENT_TAB_ID)
    })

    expect(tabIds(WT)).toEqual([MIRROR_TAB_ID])
    expect(useAppStore.getState().sleepingAgentSessionsByPaneKey[paneKey]).toBeDefined()
    expect(Object.keys(useAppStore.getState().automaticAgentResumeClaimsByTabId)).toHaveLength(0)

    // The next committed frame releases recovery on actual store evidence, healing the latch.
    mocks.queueAcceptedSnapshot.mockImplementation(() => {})
    await publish(findSubscription('session.tabs.subscribeAll'), {
      type: 'snapshot',
      ...makeHostSnapshot(WT, OTHER_HOST_SURFACE_ID, OTHER_HOST_PARENT_TAB_ID),
      snapshotVersion: 2
    })

    expect(tabIds(WT)).not.toContain(MIRROR_TAB_ID)
    expectHostOwnedRecordNotResumed(paneKey, WT, 'codex-session-patch-throw')
  })

  it('settles nothing when the patch itself throws mid-apply', async () => {
    renderHook(() => useWebSessionTabsSync())
    await act(settle)
    const paneKey = seedSleepingRecord(MIRROR_TAB_ID, WT, 'codex-session-apply-throw')
    expect(resumeSleepingAgentSessionsForWorktree(WT)).toBe(0)

    // Malformed ready-without-handle fails inside store write; no commit means no receipt.
    const malformed = makeHostSnapshot(
      WT,
      OTHER_HOST_SURFACE_ID,
      OTHER_HOST_PARENT_TAB_ID
    ) as never as { tabs: Record<string, unknown>[] }
    malformed.tabs[0]!.terminal = undefined
    await publish(findSubscription('session.tabs.subscribeAll'), {
      type: 'snapshot',
      ...malformed
    })

    expect(tabIds(WT)).toEqual([MIRROR_TAB_ID])
    expect(useAppStore.getState().sleepingAgentSessionsByPaneKey[paneKey]).toBeDefined()
    expect(Object.keys(useAppStore.getState().automaticAgentResumeClaimsByTabId)).toHaveLength(0)

    await publish(findSubscription('session.tabs.subscribeAll'), {
      type: 'snapshot',
      ...makeHostSnapshot(WT, OTHER_HOST_SURFACE_ID, OTHER_HOST_PARENT_TAB_ID),
      snapshotVersion: 2
    })

    expect(tabIds(WT)).not.toContain(MIRROR_TAB_ID)
    expectHostOwnedRecordNotResumed(paneKey, WT, 'codex-session-apply-throw')
  })
})

describe('a stale frame against a newer accepted view', () => {
  installFrameOrderingHarness()

  it('settles with no patch because rejection is backed by the accepted view', async () => {
    renderHook(() => useWebSessionTabsSync())
    await act(settle)

    // The host publishes v2 for this pane before its PTY handle lands.
    await publish(findSubscription('session.tabs.subscribeAll'), {
      type: 'snapshot',
      ...makePtylessHostSnapshot(WT, HOST_SURFACE_ID, HOST_PARENT_TAB_ID, 2)
    })

    // A re-pair voids every verdict; the accepted store view survives it.
    act(() => clearHostSessionMirrorHydration(ENV))
    const paneKey = seedSleepingRecord(MIRROR_TAB_ID, WT, 'codex-session-stale-settle')
    expect(resumeSleepingAgentSessionsForWorktree(WT)).toBe(0)

    // Rejecting a late older frame can settle using the already accepted v2 view.
    await publish(findSubscription('session.tabs.subscribeAll'), {
      type: 'snapshot',
      ...makeHostSnapshot(WT, HOST_SURFACE_ID, HOST_PARENT_TAB_ID)
    })

    expect(hasHostSessionMirrorHydrated(ENV, WT)).toBe(true)
    expectHostOwnedRecordNotResumed(paneKey, WT, 'codex-session-stale-settle')
  })
})

describe('a deferred visibility-resume repair patch', () => {
  installFrameOrderingHarness({ fakeTimers: true })

  it('settles the omitted worktree its tombstone retracts', async () => {
    renderHook(() => useWebSessionTabsSync())
    await act(settle)

    // Track both worktrees so the resume inventory can omit one of them.
    await publish(findSubscription('session.tabs.subscribeAll'), {
      type: 'snapshot',
      ...makeHostSnapshot(WT, HOST_SURFACE_ID, HOST_PARENT_TAB_ID)
    })
    await publish(findSubscription('session.tabs.subscribeAll'), {
      type: 'snapshot',
      ...makePtylessHostSnapshot(BG_WT, `host-tab-2::${LEAF_ID}`, 'host-tab-2')
    })
    act(() => clearHostSessionMirrorHydration(ENV))
    const paneKey = seedSleepingRecord(BG_MIRROR_TAB_ID, BG_WT, 'codex-session-tombstone')
    expect(resumeSleepingAgentSessionsForWorktree(BG_WT)).toBe(0)

    act(() => {
      setDocumentVisibility('hidden')
      vi.advanceTimersByTime(WINDOW_VISIBILITY_SUBSCRIPTION_PARK_DELAY_MS)
      setDocumentVisibility('visible')
      vi.advanceTimersByTime(WEB_SESSION_TABS_VISIBILITY_RESUME_STAGGER_MS)
    })
    await act(settle)

    // Recovery drops the inventory’s only published snapshot, so omission cannot settle background work.
    mocks.recoverSnapshot.mockImplementation(
      async (_state: unknown, snapshot: RuntimeMobileSessionTabsResult) =>
        snapshot.worktree === WT ? null : snapshot
    )
    await publish(findSubscription('session.tabs.subscribeAll', 1), {
      type: 'snapshots',
      snapshots: [
        { ...makeHostSnapshot(WT, HOST_SURFACE_ID, HOST_PARENT_TAB_ID), snapshotVersion: 2 }
      ],
      authoritative: true
    })

    // The repair settles hydration; a visibility retraction does not authorize a resume.
    expect(tabIds(BG_WT)).not.toContain(BG_MIRROR_TAB_ID)
    expectHostOwnedRecordNotResumed(paneKey, BG_WT, 'codex-session-tombstone')
  })
})

describe('the eager post-create list answers for its worktree', () => {
  installFrameOrderingHarness()

  it('releases the pane its retraction decides', async () => {
    const paneKey = seedSleepingRecord(MIRROR_TAB_ID, WT, 'codex-session-eager-refresh')
    expect(resumeSleepingAgentSessionsForWorktree(WT)).toBe(0)

    runtimeCall.mockImplementation((request: { method: string }) =>
      request.method === 'session.tabs.list'
        ? Promise.resolve({
            id: 'list',
            ok: true as const,
            result: makeHostSnapshot(WT, OTHER_HOST_SURFACE_ID, OTHER_HOST_PARENT_TAB_ID),
            _meta: { runtimeId: 'runtime-a' }
          })
        : new Promise(() => {})
    )
    await act(async () => {
      await refreshWebRuntimeSessionTabsSnapshot(ENV, WT)
      await settle()
    })

    // The list settled hydration, but the retracted tab must stay absent.
    expect(tabIds(WT)).not.toContain(MIRROR_TAB_ID)
    expectHostOwnedRecordNotResumed(paneKey, WT, 'codex-session-eager-refresh')
  })

  it('does not resurrect a worktree the stream retracted while the list was in flight', async () => {
    // Refresh applies from close/create/activation/split/reconnect need receipt order too; a pre-close list once landed after retraction and resurrected the tab.
    renderHook(() => useWebSessionTabsSync())
    await act(settle)

    let resolveList!: (response: unknown) => void
    runtimeCall.mockImplementation((request: { method: string }) =>
      request.method === 'session.tabs.list'
        ? new Promise((resolve) => {
            resolveList = resolve
          })
        : new Promise(() => {})
    )
    const refreshed = refreshWebRuntimeSessionTabsSnapshot(ENV, WT)
    await act(settle)

    // The close lands on the stream while that list is still out.
    await publish(findSubscription('session.tabs.subscribeAll'), {
      type: 'snapshot',
      worktree: WT,
      publicationEpoch: `removed:${(1_700_000_000_000).toString(36)}`,
      snapshotVersion: 0,
      removed: true,
      activeGroupId: null,
      activeTabId: null,
      activeTabType: null,
      tabs: []
    })
    expect(tabIds(WT)).not.toContain(MIRROR_TAB_ID)

    // The pre-close answer arrives last, at a higher version than anything since.
    resolveList({
      id: 'list',
      ok: true as const,
      result: { ...makeHostSnapshot(WT, HOST_SURFACE_ID, HOST_PARENT_TAB_ID), snapshotVersion: 9 },
      _meta: { runtimeId: 'runtime-a' }
    })
    await act(async () => {
      await refreshed
      await settle()
    })

    expect(tabIds(WT)).not.toContain(MIRROR_TAB_ID)
  })

  it('settles nothing when the list answers for a workspace the mirror never writes', async () => {
    runtimeCall.mockImplementation((request: { method: string }) =>
      request.method === 'session.tabs.list'
        ? Promise.resolve({
            id: 'list',
            ok: true as const,
            result: makeHostSnapshot(
              FLOATING_TERMINAL_WORKTREE_ID,
              FLOATING_HOST_SURFACE_ID,
              FLOATING_HOST_PARENT_TAB_ID
            ),
            _meta: { runtimeId: 'runtime-a' }
          })
        : new Promise(() => {})
    )
    await act(async () => {
      await refreshWebRuntimeSessionTabsSnapshot(ENV, FLOATING_TERMINAL_WORKTREE_ID)
      await settle()
    })

    expect(useAppStore.getState().tabsByWorktree[FLOATING_TERMINAL_WORKTREE_ID]).toBeUndefined()
    expect(hasHostSessionMirrorHydrated(ENV, FLOATING_TERMINAL_WORKTREE_ID)).toBe(false)
  })

  it('does not let a pre-reset eager list settle in the new tracking epoch', async () => {
    let resolveList!: (response: unknown) => void
    runtimeCall.mockImplementation((request: { method: string }) =>
      request.method === 'session.tabs.list'
        ? new Promise((resolve) => {
            resolveList = resolve
          })
        : new Promise(() => {})
    )
    const paneKey = seedSleepingRecord(MIRROR_TAB_ID, WT, 'codex-session-eager-old-tracking')
    expect(resumeSleepingAgentSessionsForWorktree(WT)).toBe(0)

    const refresh = refreshWebRuntimeSessionTabsSnapshot(ENV, WT)
    await act(settle)
    clearWebSessionTabsTrackingForEnvironment(ENV)
    resolveList({
      id: 'list',
      ok: true as const,
      result: makeHostSnapshot(WT, OTHER_HOST_SURFACE_ID, OTHER_HOST_PARENT_TAB_ID),
      _meta: { runtimeId: 'runtime-a' }
    })
    await act(async () => {
      await refresh
      await settle()
    })

    expect(useAppStore.getState().sleepingAgentSessionsByPaneKey[paneKey]).toBeDefined()
    expect(hasHostSessionMirrorHydrated(ENV, WT)).toBe(false)
  })
})

// Floating workspace is local synthetic state: discarded host frames have no accepted view to back settlement, unlike stale-frame rejection.
describe('a host frame for a workspace the mirror never writes', () => {
  installFrameOrderingHarness()

  it('settles nothing on the global singular path', async () => {
    renderHook(() => useWebSessionTabsSync())
    await act(settle)

    await publish(findSubscription('session.tabs.subscribeAll'), {
      type: 'snapshot',
      ...makeHostSnapshot(
        FLOATING_TERMINAL_WORKTREE_ID,
        FLOATING_HOST_SURFACE_ID,
        FLOATING_HOST_PARENT_TAB_ID
      )
    })

    expect(useAppStore.getState().tabsByWorktree[FLOATING_TERMINAL_WORKTREE_ID]).toBeUndefined()
    expect(hasHostSessionMirrorHydrated(ENV, FLOATING_TERMINAL_WORKTREE_ID)).toBe(false)
  })

  it('is left out of a partial stream inventory verdict', async () => {
    renderHook(() => useWebSessionTabsSync())
    await act(settle)

    // Dropping any worktree prevents environment-wide settlement; name accepted worktrees individually.
    mocks.recoverSnapshot.mockImplementation(
      async (_state: unknown, snapshot: RuntimeMobileSessionTabsResult) =>
        snapshot.worktree === BG_WT ? null : snapshot
    )
    await publish(findSubscription('session.tabs.subscribeAll'), {
      type: 'snapshots',
      snapshots: [
        makeHostSnapshot(WT, HOST_SURFACE_ID, HOST_PARENT_TAB_ID),
        makeHostSnapshot(BG_WT, `host-tab-2::${LEAF_ID}`, 'host-tab-2'),
        makeHostSnapshot(
          FLOATING_TERMINAL_WORKTREE_ID,
          FLOATING_HOST_SURFACE_ID,
          FLOATING_HOST_PARENT_TAB_ID
        )
      ]
    })

    expect(hasHostSessionMirrorHydrated(ENV, WT)).toBe(true)
    expect(hasHostSessionMirrorHydrated(ENV, BG_WT)).toBe(false)
    expect(hasHostSessionMirrorHydrated(ENV, FLOATING_TERMINAL_WORKTREE_ID)).toBe(false)
  })

  it('is left out of a partial initial inventory verdict', async () => {
    let resolveListAll: (response: unknown) => void = () => {}
    runtimeCall.mockImplementation((request: { method: string }) =>
      request.method === 'session.tabs.listAll'
        ? new Promise((resolve) => {
            resolveListAll = resolve
          })
        : new Promise(() => {})
    )
    mocks.recoverSnapshot.mockImplementation(
      async (_state: unknown, snapshot: RuntimeMobileSessionTabsResult) =>
        snapshot.worktree === BG_WT ? null : snapshot
    )
    renderHook(() => useWebSessionTabsSync())
    await act(settle)

    await act(async () => {
      resolveListAll({
        id: 'listall',
        ok: true as const,
        result: {
          snapshots: [
            makeHostSnapshot(WT, HOST_SURFACE_ID, HOST_PARENT_TAB_ID),
            makeHostSnapshot(BG_WT, `host-tab-2::${LEAF_ID}`, 'host-tab-2'),
            makeHostSnapshot(
              FLOATING_TERMINAL_WORKTREE_ID,
              FLOATING_HOST_SURFACE_ID,
              FLOATING_HOST_PARENT_TAB_ID
            )
          ]
        },
        _meta: { runtimeId: 'runtime-a' }
      })
      await settle()
    })

    expect(hasHostSessionMirrorHydrated(ENV, WT)).toBe(true)
    expect(hasHostSessionMirrorHydrated(ENV, BG_WT)).toBe(false)
    expect(hasHostSessionMirrorHydrated(ENV, FLOATING_TERMINAL_WORKTREE_ID)).toBe(false)
  })

  it('does not cost a complete inventory its environment-wide verdict', async () => {
    renderHook(() => useWebSessionTabsSync())
    await act(settle)
    const paneKey = seedSleepingRecord(BG_MIRROR_TAB_ID, BG_WT, 'codex-session-floating-member')
    expect(resumeSleepingAgentSessionsForWorktree(BG_WT)).toBe(0)

    // All published snapshots committed, so omission still answers for the background workspace.
    await publish(findSubscription('session.tabs.subscribeAll'), {
      type: 'snapshots',
      snapshots: [
        makeHostSnapshot(WT, HOST_SURFACE_ID, HOST_PARENT_TAB_ID),
        makeHostSnapshot(
          FLOATING_TERMINAL_WORKTREE_ID,
          FLOATING_HOST_SURFACE_ID,
          FLOATING_HOST_PARENT_TAB_ID
        )
      ]
    })

    expect(hasHostSessionMirrorHydrated(ENV, BG_WT)).toBe(true)
    expectHostOwnedRecordNotResumed(paneKey, BG_WT, 'codex-session-floating-member')
  })
})

// Zustand commits before notification; subscriber failure must retain the receipt only when patchCommitted proves the write happened.
describe('a store subscriber that throws after the commit', () => {
  installFrameOrderingHarness()

  it('still settles the frame whose patch landed', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    renderHook(() => useWebSessionTabsSync())
    await act(settle)
    const paneKey = seedSleepingRecord(MIRROR_TAB_ID, WT, 'codex-session-subscriber-throw')
    expect(resumeSleepingAgentSessionsForWorktree(WT)).toBe(0)

    // Throw once: the released drain also writes this store and must not hit the same subscriber failure.
    let threw = false
    const unsubscribe = useAppStore.subscribe(() => {
      if (threw) {
        return
      }
      threw = true
      throw new Error('agent status subscriber failed')
    })
    try {
      await publish(findSubscription('session.tabs.subscribeAll'), {
        type: 'snapshot',
        ...makeHostSnapshot(WT, OTHER_HOST_SURFACE_ID, OTHER_HOST_PARENT_TAB_ID)
      })
    } finally {
      unsubscribe()
    }

    // Require catch evidence or settle could pass without exercising the failure branch.
    expect(threw).toBe(true)
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('a store subscriber failed after the patch landed'),
      expect.anything()
    )

    expect(tabIds(WT)).not.toContain(MIRROR_TAB_ID)
    expectHostOwnedRecordNotResumed(paneKey, WT, 'codex-session-subscriber-throw')
    warn.mockRestore()
  })
})
