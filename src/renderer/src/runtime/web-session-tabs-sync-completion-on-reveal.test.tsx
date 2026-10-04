// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
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

vi.mock('./web-runtime-session', async (importOriginal) => {
  const actual = await importOriginal<typeof WebRuntimeSessionModule>()
  const { frameOrderingMocks } = await import('./host-session-mirror-frame-fixtures')
  return { ...actual, createWebRuntimeSessionTerminal: frameOrderingMocks.createTerminal }
})

import { useAppStore } from '@/store'
import { makePaneKey } from '../../../shared/stable-pane-id'
import { resolveTerminalTabActivityStatus } from '../components/tab-bar/terminal-tab-activity-status'
import {
  BG_MIRROR_TAB_ID,
  BG_WT,
  HOST_PARENT_TAB_ID,
  HOST_SURFACE_ID,
  LEAF_ID,
  MIRROR_TAB_ID,
  makeHostSnapshot,
  WT
} from './host-session-mirror-frame-fixtures'
import {
  findSubscription,
  installFrameOrderingHarness,
  publish,
  settle,
  setDocumentVisibility
} from './host-session-mirror-frame-ordering-harness'
import { useWebSessionTabsSync } from './web-session-tabs-sync'
import { WINDOW_VISIBILITY_SUBSCRIPTION_PARK_DELAY_MS } from './window-visibility-subscription-parking'

function agentSnapshot(
  worktree: string,
  parentTabId: string,
  surfaceId: string,
  state: 'working' | 'done'
) {
  const snapshot = makeHostSnapshot(worktree, surfaceId, parentTabId)
  const tab = snapshot.tabs[0]
  if (tab?.type !== 'terminal') {
    throw new Error('Missing terminal fixture')
  }
  tab.title = state === 'done' ? 'Pi ready' : '⠋ Pi'
  tab.launchAgent = 'pi'
  tab.agentStatus = {
    paneKey: makePaneKey(parentTabId, LEAF_ID),
    state,
    agentType: 'pi',
    worktreeId: worktree,
    updatedAt: Date.now(),
    stateStartedAt: Date.now(),
    stateHistory: [],
    prompt: ''
  }
  snapshot.snapshotVersion = state === 'done' ? 2 : 1
  return snapshot
}

function tabActivity(tabId: string, worktreeId: string) {
  const state = useAppStore.getState()
  const tab = state.tabsByWorktree[worktreeId]?.find((tab) => tab.id === tabId)
  if (!tab) {
    throw new Error('Missing mirrored terminal')
  }
  return resolveTerminalTabActivityStatus({
    tab,
    agentStatusByPaneKey: state.agentStatusByPaneKey,
    agentStatusEpoch: state.agentStatusEpoch,
    runtimePaneTitlesByTabId: state.runtimePaneTitlesByTabId,
    ptyIdsByTabId: state.ptyIdsByTabId,
    terminalLayout: state.terminalLayoutsByTabId[tabId]
  })
}

describe('remote completion after the client window is hidden', () => {
  installFrameOrderingHarness({ fakeTimers: true })

  it('resubscribes immediately on reveal and repairs completion in active and inactive workspaces', async () => {
    renderHook(() => useWebSessionTabsSync())
    await act(settle)
    await publish(findSubscription('session.tabs.subscribeAll'), {
      type: 'snapshots',
      authoritative: true,
      snapshots: [
        agentSnapshot(WT, HOST_PARENT_TAB_ID, HOST_SURFACE_ID, 'working'),
        agentSnapshot(BG_WT, 'host-tab-2', `host-tab-2::${LEAF_ID}`, 'working')
      ]
    })
    useAppStore.setState({
      runtimePaneTitlesByTabId: {
        [MIRROR_TAB_ID]: { 1: '⠋ Pi' },
        [BG_MIRROR_TAB_ID]: { 1: '⠋ Pi' }
      }
    })
    expect(tabActivity(MIRROR_TAB_ID, WT)).toBe('working')
    expect(tabActivity(BG_MIRROR_TAB_ID, BG_WT)).toBe('working')
    act(() => {
      setDocumentVisibility('hidden')
      vi.advanceTimersByTime(WINDOW_VISIBILITY_SUBSCRIPTION_PARK_DELAY_MS)
      setDocumentVisibility('visible')
    })
    await act(settle)
    await publish(findSubscription('session.tabs.subscribeAll', 1), {
      type: 'snapshots',
      authoritative: true,
      snapshots: [
        agentSnapshot(WT, HOST_PARENT_TAB_ID, HOST_SURFACE_ID, 'done'),
        agentSnapshot(BG_WT, 'host-tab-2', `host-tab-2::${LEAF_ID}`, 'done')
      ]
    })
    expect(tabActivity(MIRROR_TAB_ID, WT)).toBe('done')
    expect(tabActivity(BG_MIRROR_TAB_ID, BG_WT)).toBe('done')
    expect(useAppStore.getState().runtimePaneTitlesByTabId).toMatchObject({
      [MIRROR_TAB_ID]: { 1: 'Pi ready' },
      [BG_MIRROR_TAB_ID]: { 1: 'Pi ready' }
    })
  })
})
