// @vitest-environment happy-dom

import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-types'
import type * as WebRuntimeSessionModule from './web-runtime-session'
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
    useRuntimeSessionMirrorEnvironmentKey: frameOrderingMocks.runtimeSessionMirrorEnvironmentKey
  }
})

vi.mock('./web-session-terminal-orphan-recovery', async () => {
  const { frameOrderingMocks } = await import('./host-session-mirror-frame-fixtures')
  return { recoverWebSessionTerminalOrphansBeforeApply: frameOrderingMocks.recoverSnapshot }
})

vi.mock('./web-runtime-session', async (importOriginal) => {
  const actual = await importOriginal<typeof WebRuntimeSessionModule>()
  const { frameOrderingMocks } = await import('./host-session-mirror-frame-fixtures')
  return { ...actual, createWebRuntimeSessionTerminal: frameOrderingMocks.createTerminal }
})

import { useAppStore } from '@/store'
import { resumeSleepingAgentSessionsForWorktree } from '@/lib/resume-sleeping-agent-session'
import {
  takeAllPendingBackgroundTerminalWorktreeMounts,
  takePendingBackgroundTerminalWorktreeMount
} from '@/components/terminal/background-terminal-worktree-mount'
import { wakeSleepingAgentsForWorktreeInBackground } from '@/lib/wake-sleeping-agents-in-background'
import {
  BG_MIRROR_TAB_ID,
  BG_WT,
  ENV,
  frameOrderingMocks as mocks,
  HOST_PARENT_TAB_ID,
  HOST_PTY_ID,
  HOST_SURFACE_ID,
  LEAF_ID,
  MIRROR_TAB_ID,
  makeEmptyHostSnapshot,
  makeHostSnapshot,
  OTHER_HOST_PARENT_TAB_ID,
  OTHER_HOST_SURFACE_ID,
  WT
} from './host-session-mirror-frame-fixtures'
import {
  expectReplayedResume,
  findSubscription,
  installFrameOrderingHarness,
  publish,
  runtimeCall,
  seedSleepingRecord,
  settle,
  setDocumentVisibility,
  tabIds
} from './host-session-mirror-frame-ordering-harness'
import {
  clearWebSessionTabsTrackingForEnvironment,
  useWebSessionTabsSync,
  WEB_SESSION_TABS_VISIBILITY_RESUME_STAGGER_MS
} from './web-session-tabs-sync'
import { hasHostSessionMirrorHydrated } from './host-session-mirror-hydration'
import { WINDOW_VISIBILITY_SUBSCRIPTION_PARK_DELAY_MS } from './window-visibility-subscription-parking'

/**
 * Parked waiters drain synchronously, so a settle placed before its frame's
 * patch reaches the store re-runs recovery while ptyIdsByTabId is still empty
 * — the pane reads as dead and the duplicate `codex resume` fires anyway.
 * These drive the real handlers because that ordering is the thing under test.
 *
 * The second block pins the other half: this latch releases into replaying a
 * resume, so `unverifiable` must not read as `exited` and settle anything.
 */
describe('mirrored-pane resume deferral against real stream frames', () => {
  installFrameOrderingHarness()

  it('does not let late bootstrap inventory restore a pre-restart terminal handle', async () => {
    let resolveListAll: (response: unknown) => void = () => {}
    runtimeCall.mockImplementation((request: { method: string }) =>
      request.method === 'session.tabs.listAll'
        ? new Promise((resolve) => {
            resolveListAll = resolve
          })
        : new Promise(() => {})
    )
    renderHook(() => useWebSessionTabsSync())
    await act(settle)

    const beforeRestart = makeHostSnapshot(WT, HOST_SURFACE_ID, HOST_PARENT_TAB_ID)
    beforeRestart.publicationEpoch = 'before-restart'
    if (beforeRestart.tabs[0]?.type !== 'terminal') {
      throw new Error('fixture must contain a terminal surface')
    }
    beforeRestart.tabs[0].terminal = 'terminal-before-restart'
    const afterRestart = makeHostSnapshot(WT, HOST_SURFACE_ID, HOST_PARENT_TAB_ID)
    afterRestart.publicationEpoch = 'after-restart'
    if (afterRestart.tabs[0]?.type !== 'terminal') {
      throw new Error('fixture must contain a terminal surface')
    }
    afterRestart.tabs[0].terminal = 'terminal-after-restart'
    const afterRestartPtyId = `remote:${ENV}@@terminal-after-restart`

    await publish(findSubscription('session.tabs.subscribeAll'), {
      type: 'updated',
      ...afterRestart
    })
    expect(useAppStore.getState().ptyIdsByTabId[MIRROR_TAB_ID]).toEqual([afterRestartPtyId])

    await act(async () => {
      resolveListAll({
        id: 'listall-before-restart',
        ok: true as const,
        result: { snapshots: [beforeRestart] },
        _meta: { runtimeId: 'runtime-a' }
      })
      await settle()
    })

    const state = useAppStore.getState()
    expect(state.ptyIdsByTabId[MIRROR_TAB_ID]).toEqual([afterRestartPtyId])
    expect(state.tabsByWorktree[WT]?.find((tab) => tab.id === MIRROR_TAB_ID)?.ptyId).toBe(
      afterRestartPtyId
    )
    expect(state.terminalLayoutsByTabId[MIRROR_TAB_ID]?.ptyIdsByLeafId?.[LEAF_ID]).toBe(
      afterRestartPtyId
    )
  })

  it('does not let late bootstrap inventory repopulate after a newer empty inventory', async () => {
    let resolveListAll: (response: unknown) => void = () => {}
    runtimeCall.mockImplementation((request: { method: string }) =>
      request.method === 'session.tabs.listAll'
        ? new Promise((resolve) => {
            resolveListAll = resolve
          })
        : new Promise(() => {})
    )
    renderHook(() => useWebSessionTabsSync())
    await act(settle)

    const beforeRestart = makeHostSnapshot(WT, HOST_SURFACE_ID, HOST_PARENT_TAB_ID)
    beforeRestart.publicationEpoch = 'before-empty-inventory'
    if (beforeRestart.tabs[0]?.type !== 'terminal') {
      throw new Error('fixture must contain a terminal surface')
    }
    beforeRestart.tabs[0].terminal = 'terminal-before-empty-inventory'

    await publish(findSubscription('session.tabs.subscribeAll'), {
      type: 'snapshots',
      snapshots: []
    })

    await act(async () => {
      resolveListAll({
        id: 'listall-before-empty-inventory',
        ok: true as const,
        result: { snapshots: [beforeRestart] },
        _meta: { runtimeId: 'runtime-a' }
      })
      await settle()
    })

    // The empty full inventory is newer evidence; the late list must not
    // reinsert its stale host handle into the renderer's existing mirror row.
    const state = useAppStore.getState()
    expect(state.ptyIdsByTabId[MIRROR_TAB_ID]).toBeUndefined()
    expect(state.tabsByWorktree[WT]?.find((tab) => tab.id === MIRROR_TAB_ID)?.ptyId).toBeNull()
  })

  it('does not let a late bootstrap runtime id retire a newer stream runtime', async () => {
    let resolveListAll: (response: unknown) => void = () => {}
    runtimeCall.mockImplementation((request: { method: string }) =>
      request.method === 'session.tabs.listAll'
        ? new Promise((resolve) => {
            resolveListAll = resolve
          })
        : new Promise(() => {})
    )
    renderHook(() => useWebSessionTabsSync())
    await act(settle)

    const backgroundParentTabId = 'host-tab-2'
    const backgroundSurfaceId = `${backgroundParentTabId}::${LEAF_ID}`
    const firstRuntimeB = makeHostSnapshot(BG_WT, backgroundSurfaceId, backgroundParentTabId)
    firstRuntimeB.publicationEpoch = 'runtime-b-epoch'
    if (firstRuntimeB.tabs[0]?.type !== 'terminal') {
      throw new Error('fixture must contain a terminal surface')
    }
    firstRuntimeB.tabs[0].terminal = 'runtime-b-terminal-1'
    await publish(
      findSubscription('session.tabs.subscribeAll'),
      { type: 'updated', ...firstRuntimeB },
      'runtime-b'
    )

    const lateRuntimeA = makeHostSnapshot(WT, HOST_SURFACE_ID, HOST_PARENT_TAB_ID)
    lateRuntimeA.publicationEpoch = 'runtime-a-epoch'
    if (lateRuntimeA.tabs[0]?.type !== 'terminal') {
      throw new Error('fixture must contain a terminal surface')
    }
    lateRuntimeA.tabs[0].terminal = 'runtime-a-terminal'
    await act(async () => {
      resolveListAll({
        id: 'listall-after-runtime-restart',
        ok: true as const,
        result: { snapshots: [lateRuntimeA] },
        _meta: { runtimeId: 'runtime-a' }
      })
      await settle()
    })

    const secondRuntimeB = makeHostSnapshot(BG_WT, backgroundSurfaceId, backgroundParentTabId)
    secondRuntimeB.publicationEpoch = 'runtime-b-epoch'
    secondRuntimeB.snapshotVersion = 2
    if (secondRuntimeB.tabs[0]?.type !== 'terminal') {
      throw new Error('fixture must contain a terminal surface')
    }
    secondRuntimeB.tabs[0].terminal = 'runtime-b-terminal-2'
    await publish(
      findSubscription('session.tabs.subscribeAll'),
      { type: 'updated', ...secondRuntimeB },
      'runtime-b'
    )

    expect(useAppStore.getState().ptyIdsByTabId[BG_MIRROR_TAB_ID]).toEqual([
      `remote:${ENV}@@runtime-b-terminal-2`
    ])
  })

  it('does not relaunch when a stream frame is the first hydration signal', async () => {
    renderHook(() => useWebSessionTabsSync())
    await act(settle)
    const paneKey = seedSleepingRecord(MIRROR_TAB_ID, WT, 'codex-session-ordering-1')

    // Nothing has hydrated yet, so the sweep must park rather than relaunch.
    expect(resumeSleepingAgentSessionsForWorktree(WT)).toBe(0)
    expect(tabIds(WT)).toEqual([MIRROR_TAB_ID])

    // The host answers on the stream, before listAll ever resolves. The frame
    // says this pane's PTY is alive; the replay must see that, not the empty
    // handle map that existed when the frame arrived.
    await publish(findSubscription('session.tabs.subscribeAll'), {
      type: 'snapshots',
      snapshots: [makeHostSnapshot(WT, HOST_SURFACE_ID, 'host-tab-1')]
    })

    expect(useAppStore.getState().ptyIdsByTabId[MIRROR_TAB_ID]).toEqual([HOST_PTY_ID])
    // RED before the ordering fix: the drain ran while ptyIdsByTabId was still
    // empty, so a second `codex resume` tab was appended here.
    expect(tabIds(WT)).toEqual([MIRROR_TAB_ID])
    expect(useAppStore.getState().sleepingAgentSessionsByPaneKey[paneKey]).toBeDefined()
    expect(Object.keys(useAppStore.getState().automaticAgentResumeClaimsByTabId)).toHaveLength(0)
  })

  it('a single-worktree frame does not release panes parked on another worktree', async () => {
    renderHook(() => useWebSessionTabsSync())
    await act(settle)
    const backgroundPaneKey = seedSleepingRecord(BG_MIRROR_TAB_ID, BG_WT, 'codex-session-bg-1')

    expect(resumeSleepingAgentSessionsForWorktree(BG_WT)).toBe(0)

    // The active worktree's scoped mirror answers. It says nothing whatsoever
    // about the background workspace, so that pane must stay parked.
    await publish(findSubscription('session.tabs.subscribe'), {
      type: 'snapshot',
      ...makeHostSnapshot(WT, HOST_SURFACE_ID, 'host-tab-1')
    })

    expect(tabIds(BG_WT)).toEqual([BG_MIRROR_TAB_ID])
    expect(useAppStore.getState().sleepingAgentSessionsByPaneKey[backgroundPaneKey]).toBeDefined()

    // A full inventory DOES speak for every worktree, including by omission.
    await publish(findSubscription('session.tabs.subscribeAll'), {
      type: 'snapshots',
      snapshots: [makeHostSnapshot(WT, HOST_SURFACE_ID, 'host-tab-1')]
    })

    // The background mirror tab was retracted by the inventory, so recovery is
    // finally justified: the record is consumed INTO a replacement tab that
    // claims the session. Asserting only the record would pass for a replay
    // that cleared it and launched nothing.
    const replayed = useAppStore.getState()
    expect(replayed.sleepingAgentSessionsByPaneKey[backgroundPaneKey]).toBeUndefined()
    const backgroundTabIds = tabIds(BG_WT)
    expect(backgroundTabIds).toHaveLength(1)
    expect(backgroundTabIds[0]).not.toBe(BG_MIRROR_TAB_ID)
    expect(replayed.automaticAgentResumeClaimsByTabId[backgroundTabIds[0]!]).toMatchObject({
      launchAgent: 'codex',
      providerSession: { key: 'session_id', id: 'codex-session-bg-1' }
    })
  })

  // The three tests below pin the remaining release sites one frame at a time:
  // each delivers ONLY its own path's frame, so a release that stops happening
  // there cannot be covered for by another handler.
  it('the initial listAll releases the pane it parked', async () => {
    let resolveListAll: (response: unknown) => void = () => {}
    runtimeCall.mockImplementation((request: { method: string }) =>
      request.method === 'session.tabs.listAll'
        ? new Promise((resolve) => {
            resolveListAll = resolve
          })
        : new Promise(() => {})
    )
    renderHook(() => useWebSessionTabsSync())
    await act(settle)
    const paneKey = seedSleepingRecord(MIRROR_TAB_ID, WT, 'codex-session-listall-release')
    expect(resumeSleepingAgentSessionsForWorktree(WT)).toBe(0)

    // The inventory retracts the mirror tab, so the host HAS spoken: this pane
    // is gone and the resume it parked is finally justified.
    await act(async () => {
      resolveListAll({
        id: 'listall',
        ok: true as const,
        result: {
          snapshots: [makeHostSnapshot(WT, OTHER_HOST_SURFACE_ID, OTHER_HOST_PARENT_TAB_ID)]
        },
        _meta: { runtimeId: 'runtime-a' }
      })
      await settle()
    })

    expect(tabIds(WT)).not.toContain(MIRROR_TAB_ID)
    expectReplayedResume(paneKey, WT, 'codex-session-listall-release')
  })

  it('a single frame on the global stream releases the pane it parked', async () => {
    renderHook(() => useWebSessionTabsSync())
    await act(settle)
    const paneKey = seedSleepingRecord(MIRROR_TAB_ID, WT, 'codex-session-global-frame')
    expect(resumeSleepingAgentSessionsForWorktree(WT)).toBe(0)

    await publish(findSubscription('session.tabs.subscribeAll'), {
      type: 'snapshot',
      ...makeHostSnapshot(WT, OTHER_HOST_SURFACE_ID, OTHER_HOST_PARENT_TAB_ID)
    })

    expect(tabIds(WT)).not.toContain(MIRROR_TAB_ID)
    expectReplayedResume(paneKey, WT, 'codex-session-global-frame')
  })

  it('the active-worktree scoped frame releases the pane it parked', async () => {
    renderHook(() => useWebSessionTabsSync())
    await act(settle)
    const paneKey = seedSleepingRecord(MIRROR_TAB_ID, WT, 'codex-session-scoped-frame')
    expect(resumeSleepingAgentSessionsForWorktree(WT)).toBe(0)

    await publish(findSubscription('session.tabs.subscribe'), {
      type: 'snapshot',
      ...makeHostSnapshot(WT, OTHER_HOST_SURFACE_ID, OTHER_HOST_PARENT_TAB_ID)
    })

    expect(tabIds(WT)).not.toContain(MIRROR_TAB_ID)
    expectReplayedResume(paneKey, WT, 'codex-session-scoped-frame')
  })

  it('does not let a scoped frame from before tracking reset release its pane', async () => {
    renderHook(() => useWebSessionTabsSync())
    await act(settle)
    const paneKey = seedSleepingRecord(MIRROR_TAB_ID, WT, 'codex-session-scoped-old-tracking')
    expect(resumeSleepingAgentSessionsForWorktree(WT)).toBe(0)

    clearWebSessionTabsTrackingForEnvironment(ENV)
    await publish(findSubscription('session.tabs.subscribe'), {
      type: 'snapshot',
      ...makeHostSnapshot(WT, OTHER_HOST_SURFACE_ID, OTHER_HOST_PARENT_TAB_ID)
    })

    expect(useAppStore.getState().sleepingAgentSessionsByPaneKey[paneKey]).toBeDefined()
    expect(hasHostSessionMirrorHydrated(ENV, WT)).toBe(false)
  })
})

describe('mirror latch verdicts against real stream failures', () => {
  installFrameOrderingHarness()

  it('a rejected inventory keeps a parked pane parked', async () => {
    let rejectListAll: (error: Error) => void = () => {}
    runtimeCall.mockImplementation((request: { method: string }) =>
      request.method === 'session.tabs.listAll'
        ? new Promise((_resolve, reject) => {
            rejectListAll = reject
          })
        : new Promise(() => {})
    )
    renderHook(() => useWebSessionTabsSync())
    await act(settle)
    const paneKey = seedSleepingRecord(MIRROR_TAB_ID, WT, 'codex-session-listall-reject')
    expect(resumeSleepingAgentSessionsForWorktree(WT)).toBe(0)

    // Contact is lost AFTER the pane parked. That is `unverifiable`, not proof
    // the host-owned PTY exited, so nothing may drain on it.
    await act(async () => {
      rejectListAll(new Error('relay disconnected'))
      await settle()
    })

    expect(tabIds(WT)).toEqual([MIRROR_TAB_ID])
    expect(useAppStore.getState().sleepingAgentSessionsByPaneKey[paneKey]).toBeDefined()
    expect(Object.keys(useAppStore.getState().automaticAgentResumeClaimsByTabId)).toHaveLength(0)
  })

  it('a scoped stream error settles neither its own worktree nor another', async () => {
    renderHook(() => useWebSessionTabsSync())
    await act(settle)
    const activePaneKey = seedSleepingRecord(MIRROR_TAB_ID, WT, 'codex-session-active-error')
    const backgroundPaneKey = seedSleepingRecord(BG_MIRROR_TAB_ID, BG_WT, 'codex-session-bg-error')
    expect(resumeSleepingAgentSessionsForWorktree(WT)).toBe(0)
    expect(resumeSleepingAgentSessionsForWorktree(BG_WT)).toBe(0)

    await act(async () => {
      findSubscription('session.tabs.subscribe').callbacks.onError?.({
        message: 'stream closed'
      } as never)
      await settle()
    })

    const state = useAppStore.getState()
    expect(tabIds(WT)).toEqual([MIRROR_TAB_ID])
    expect(state.sleepingAgentSessionsByPaneKey[activePaneKey]).toBeDefined()
    expect(tabIds(BG_WT)).toEqual([BG_MIRROR_TAB_ID])
    expect(state.sleepingAgentSessionsByPaneKey[backgroundPaneKey]).toBeDefined()
    expect(Object.keys(state.automaticAgentResumeClaimsByTabId)).toHaveLength(0)
  })

  it('a spawn that rejects after the patch still settles the frame that landed', async () => {
    renderHook(() => useWebSessionTabsSync())
    await act(settle)
    const paneKey = seedSleepingRecord(MIRROR_TAB_ID, WT, 'codex-session-spawn-reject')
    expect(resumeSleepingAgentSessionsForWorktree(WT)).toBe(0)

    // The wake respawn this frame triggers fails, but the frame it failed after
    // already reached the store — the host is healthy and has spoken.
    mocks.createTerminal.mockRejectedValue(new Error('spawn failed'))
    await publish(findSubscription('session.tabs.subscribe'), {
      type: 'snapshot',
      ...makeEmptyHostSnapshot(WT)
    })

    expect(mocks.createTerminal).toHaveBeenCalled()
    expect(tabIds(WT)).not.toContain(MIRROR_TAB_ID)
    expectReplayedResume(paneKey, WT, 'codex-session-spawn-reject')
  })

  it('a rejection before the patch settles nothing', async () => {
    renderHook(() => useWebSessionTabsSync())
    await act(settle)
    const paneKey = seedSleepingRecord(MIRROR_TAB_ID, WT, 'codex-session-preapply-reject')
    expect(resumeSleepingAgentSessionsForWorktree(WT)).toBe(0)

    // Nothing of this frame reached the store, so it is no evidence at all.
    mocks.recoverSnapshot.mockRejectedValue(new Error('orphan recovery failed'))
    await publish(findSubscription('session.tabs.subscribe'), {
      type: 'snapshot',
      ...makeHostSnapshot(WT, OTHER_HOST_SURFACE_ID, OTHER_HOST_PARENT_TAB_ID)
    })

    expect(tabIds(WT)).toEqual([MIRROR_TAB_ID])
    expect(useAppStore.getState().sleepingAgentSessionsByPaneKey[paneKey]).toBeDefined()
    expect(Object.keys(useAppStore.getState().automaticAgentResumeClaimsByTabId)).toHaveLength(0)
  })

  it('an inventory whose recovery drops a worktree settles only the applied ones', async () => {
    renderHook(() => useWebSessionTabsSync())
    await act(settle)
    const backgroundPaneKey = seedSleepingRecord(BG_MIRROR_TAB_ID, BG_WT, 'codex-session-bg-drop')
    expect(resumeSleepingAgentSessionsForWorktree(BG_WT)).toBe(0)

    // The background snapshot never reaches the store, so the pane it would
    // have published a PTY for is still unaccounted for.
    mocks.recoverSnapshot.mockImplementation(
      async (_state: unknown, snapshot: RuntimeMobileSessionTabsResult) =>
        snapshot.worktree === BG_WT ? null : snapshot
    )
    await publish(findSubscription('session.tabs.subscribeAll'), {
      type: 'snapshots',
      snapshots: [
        makeHostSnapshot(WT, HOST_SURFACE_ID, HOST_PARENT_TAB_ID),
        makeHostSnapshot(BG_WT, `host-tab-2::${LEAF_ID}`, 'host-tab-2')
      ]
    })

    expect(useAppStore.getState().ptyIdsByTabId[MIRROR_TAB_ID]).toEqual([HOST_PTY_ID])
    expect(tabIds(BG_WT)).toEqual([BG_MIRROR_TAB_ID])
    expect(useAppStore.getState().sleepingAgentSessionsByPaneKey[backgroundPaneKey]).toBeDefined()
  })
})

describe('a parked wake replay keeps the mount contract of its caller', () => {
  installFrameOrderingHarness()
  beforeEach(takeAllPendingBackgroundTerminalWorktreeMounts)
  afterEach(takeAllPendingBackgroundTerminalWorktreeMounts)

  it('background-mounts the resume tab a parked sweep replayed', async () => {
    renderHook(() => useWebSessionTabsSync())
    await act(settle)
    const paneKey = seedSleepingRecord(BG_MIRROR_TAB_ID, BG_WT, 'codex-session-parked-wake')

    // A phone opens a workspace the desktop is not looking at, while the mirror
    // for its pane is still unanswered — so the sweep parks instead of resuming.
    wakeSleepingAgentsForWorktreeInBackground(BG_WT)
    expect(takePendingBackgroundTerminalWorktreeMount(BG_WT)).toBeNull()

    // The inventory retracts the background mirror tab, releasing the waiter.
    await publish(findSubscription('session.tabs.subscribeAll'), {
      type: 'snapshots',
      snapshots: [makeHostSnapshot(WT, HOST_SURFACE_ID, HOST_PARENT_TAB_ID)]
    })

    expectReplayedResume(paneKey, BG_WT, 'codex-session-parked-wake')
    const launchedTabId = Object.keys(useAppStore.getState().automaticAgentResumeClaimsByTabId)[0]!
    // Why: the replayed tab is created activate:false, so nothing else mounts it
    // and its queued `--resume` never reaches a PTY.
    expect(takePendingBackgroundTerminalWorktreeMount(BG_WT)?.tabIds).toEqual([launchedTabId])
  })
})

describe('an inventory whose post-patch bookkeeping throws', () => {
  installFrameOrderingHarness({ fakeTimers: true })

  it('still settles the frames that reached the store', async () => {
    renderHook(() => useWebSessionTabsSync())
    await act(settle)

    // Seeds this worktree's freshness — so the resume inventory reads as
    // unchanged for it — without settling the environment latch.
    await publish(findSubscription('session.tabs.subscribe'), {
      type: 'snapshot',
      ...makeHostSnapshot(WT, HOST_SURFACE_ID, HOST_PARENT_TAB_ID)
    })
    const paneKey = seedSleepingRecord(BG_MIRROR_TAB_ID, BG_WT, 'codex-session-bookkeeping-throw')
    expect(resumeSleepingAgentSessionsForWorktree(BG_WT)).toBe(0)

    act(() => {
      setDocumentVisibility('hidden')
      vi.advanceTimersByTime(WINDOW_VISIBILITY_SUBSCRIPTION_PARK_DELAY_MS)
      setDocumentVisibility('visible')
      vi.advanceTimersByTime(WEB_SESSION_TABS_VISIBILITY_RESUME_STAGGER_MS)
    })
    await act(settle)

    // Bookkeeping for the unchanged worktree fails AFTER the background
    // worktree's patch landed — a healthy host that has already spoken.
    mocks.queueAcceptedSnapshot.mockImplementation((snapshot: RuntimeMobileSessionTabsResult) => {
      if (snapshot.worktree === WT) {
        throw new Error('accepted-handle queue failed')
      }
    })
    await publish(findSubscription('session.tabs.subscribeAll', 1), {
      type: 'snapshots',
      snapshots: [
        makeHostSnapshot(WT, HOST_SURFACE_ID, HOST_PARENT_TAB_ID),
        makeHostSnapshot(BG_WT, OTHER_HOST_SURFACE_ID, OTHER_HOST_PARENT_TAB_ID)
      ]
    })

    // Only the post-patch site queues the unchanged worktree, so this proves
    // the throw landed after the background patch reached the store.
    expect(mocks.queueAcceptedSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({ worktree: WT }),
      ENV
    )
    expect(tabIds(BG_WT)).not.toContain(BG_MIRROR_TAB_ID)
    expectReplayedResume(paneKey, BG_WT, 'codex-session-bookkeeping-throw')
  })
})
