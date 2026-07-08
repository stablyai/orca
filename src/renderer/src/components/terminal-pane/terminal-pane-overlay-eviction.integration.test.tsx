// @vitest-environment happy-dom
//
// STA-1282 P0 integration test. The unit tests for the coordinator call
// noteTerminalPaneVisibility() directly, which BYPASSES the real bug: the
// visible->hidden report has to survive the render/mount-gate seam. This test
// renders the real TerminalPaneOverlayLayer (real store + real coordinator, only
// TerminalPane stubbed) so the visibility reporter runs through React exactly as
// it does live. It is the regression lock for "warm set stays {} forever".

import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Tab, TabGroup, TerminalTab } from '../../../../shared/types'
import { useAppStore } from '@/store'
import { __resetTerminalPaneEvictionCoordinatorForTest } from './terminal-pane-eviction-coordinator'
import { __resetEvictedPaneRegistryForTest } from './evicted-pane-registry'

vi.mock('./TerminalPane', () => ({
  default: ({ tabId }: { tabId: string }) => <div data-testid={`pane-${tabId}`} />
}))
// Not under test; its keydown/store effects would only add noise.
vi.mock('../native-chat/use-native-chat-toggle-shortcut', () => ({
  useNativeChatToggleShortcut: () => {}
}))

import TerminalPaneOverlayLayer from './TerminalPaneOverlayLayer'

const WT = 'wt-1'

function terminalTab(id: string): TerminalTab {
  return {
    id,
    ptyId: `pty-${id}`,
    worktreeId: WT,
    title: id,
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 0
  }
}

function unifiedTab(entityId: string, sortOrder: number): Tab {
  return {
    id: `u-${entityId}`,
    entityId,
    groupId: 'g1',
    worktreeId: WT,
    contentType: 'terminal',
    label: entityId,
    customLabel: null,
    color: null,
    sortOrder,
    createdAt: sortOrder + 1
  }
}

function group(activeEntityId: string): TabGroup {
  return {
    id: 'g1',
    worktreeId: WT,
    activeTabId: `u-${activeEntityId}`,
    tabOrder: ['u-a', 'u-b']
  }
}

function seed(activeEntityId: string): void {
  useAppStore.setState({
    tabsByWorktree: { [WT]: [terminalTab('a'), terminalTab('b')] },
    unifiedTabsByWorktree: { [WT]: [unifiedTab('a', 0), unifiedTab('b', 1)] },
    groupsByWorktree: { [WT]: [group(activeEntityId)] },
    activeGroupIdByWorktree: { [WT]: 'g1' },
    ptyIdsByTabId: { a: ['pty-a'], b: ['pty-b'] },
    suppressedPtyExitIds: {},
    terminalPaneMountByTabId: {},
    settings: {
      ...useAppStore.getState().settings,
      experimentalTerminalPaneEviction: true,
      terminalPaneEvictionWarmBudget: 4,
      terminalPaneEvictionAfterMinutes: 5
    } as never
  })
}

function setActiveEntity(entityId: string): void {
  act(() => {
    useAppStore.setState({ groupsByWorktree: { [WT]: [group(entityId)] } })
  })
}

async function flush(): Promise<void> {
  // Let the reporter effect run, then the coordinator's queued recompute +
  // the pushMountMap store write it triggers, then the resulting re-render.
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
  })
}

function mountMap(): Record<string, boolean> {
  return useAppStore.getState().terminalPaneMountByTabId
}

describe('TerminalPaneOverlayLayer eviction seam (P0 integration)', () => {
  beforeEach(() => {
    ;(globalThis as { requestIdleCallback?: unknown }).requestIdleCallback = undefined
    __resetTerminalPaneEvictionCoordinatorForTest()
    __resetEvictedPaneRegistryForTest()
    seed('a')
  })

  afterEach(() => {
    cleanup()
    __resetTerminalPaneEvictionCoordinatorForTest()
    __resetEvictedPaneRegistryForTest()
    useAppStore.setState({ terminalPaneMountByTabId: {} })
  })

  function renderOverlay(): ReturnType<typeof render> {
    return render(
      <TerminalPaneOverlayLayer worktreeId={WT} worktreePath="/wt-1" isWorktreeActive={true} />
    )
  }

  it('P0-1: switching a tab visible->hidden warms it through the real render cycle', async () => {
    const view = renderOverlay()
    await flush()
    // 'a' is visible; 'b' was never visible so it must not mount (no PTY spawn).
    expect(view.queryByTestId('pane-a')).not.toBeNull()
    expect(view.queryByTestId('pane-b')).toBeNull()

    // Switch to 'b': 'a' flips visible->hidden. The reporter (not the gated slot)
    // must report the hide so the coordinator brings 'a' under warm management.
    setActiveEntity('b')
    await flush()

    // The core of the live P0-1: 'a' is now warm-mounted. Before the ungated
    // reporter this stayed {} forever (the slot unmounted before it could report).
    expect(mountMap().a).toBe(true)
    // Warm 'a' stays mounted (Tier 1); 'b' is now visible.
    expect(view.queryByTestId('pane-a')).not.toBeNull()
    expect(view.queryByTestId('pane-b')).not.toBeNull()
  })

  it('P0-1: the hide report fires even when the warm map did not retain the tab', async () => {
    // Reproduce the live deadlock directly: force the warm map empty while 'a' is
    // still visible (simulating the visible-phase write never landing). On the
    // hide render the gated slot for 'a' unmounts (isWarm=false) — so a reporter
    // living inside that slot would never fire the hide. The ungated reporter
    // still fires it, so 'a' recovers into the warm set instead of deadlocking.
    const view = renderOverlay()
    await flush()
    act(() => {
      useAppStore.setState({ terminalPaneMountByTabId: {} })
    })

    setActiveEntity('b')
    await flush()

    expect(mountMap().a).toBe(true)
    expect(view.queryByTestId('pane-a')).not.toBeNull()
  })

  it('P0-1 gate #9: hide then immediately re-show never leaves the tab managed for eviction', async () => {
    const view = renderOverlay()
    await flush()
    setActiveEntity('b') // hide 'a'
    await flush()
    setActiveEntity('a') // re-show 'a' before any dwell
    await flush()

    // 'a' is visible again and still mounted; 'b' went warm on its own hide.
    expect(view.queryByTestId('pane-a')).not.toBeNull()
    expect(mountMap().a).toBe(true)
    expect(mountMap().b).toBe(true)
  })

  it('P0-2: closing a warm hidden tab unmounts its pane (reaches the destroy teardown)', async () => {
    const view = renderOverlay()
    await flush()
    setActiveEntity('b') // 'a' -> warm hidden
    await flush()
    expect(view.queryByTestId('pane-a')).not.toBeNull()

    // Close 'a' while it is hidden+warm: the store drops it and the overlay stops
    // rendering its slot, so the real TerminalPane unmount teardown runs (destroy
    // -> pty.kill, asserted directly in pane-unmount-action.test.ts). No orphan.
    act(() => {
      useAppStore.setState({
        tabsByWorktree: { [WT]: [terminalTab('b')] },
        unifiedTabsByWorktree: { [WT]: [unifiedTab('b', 1)] },
        groupsByWorktree: { [WT]: [group('b')] }
      })
    })
    await flush()
    expect(view.queryByTestId('pane-a')).toBeNull()
  })
})
