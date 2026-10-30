import { describe, expect, it } from 'vitest'
import {
  createHarnessStoreState,
  loadIpcEventsHarness,
  type HarnessStoreState
} from './ipc-events-test-harness'

const WORKTREE_ID = 'wt-1'

function revealIdentity(tabId: string) {
  return { worktreeId: WORKTREE_ID, tabId, leafId: 'leaf-b', ptyId: 'pty-b' }
}

function revealSplitPaneFromMobile(harness: {
  createTerminal: (request: {
    requestId?: string
    worktreeId: string
    ptyId?: string
    tabId?: string
    leafId?: string
    presentation?: 'background' | 'focused'
    title?: string
  }) => void
}): void {
  harness.createTerminal({
    requestId: 'mobile-reveal',
    worktreeId: WORKTREE_ID,
    ptyId: 'pty-b',
    tabId: 'tab-split',
    leafId: 'leaf-b',
    presentation: 'focused',
    title: 'codex'
  })
}

describe('mobile terminal reveal tab adoption', () => {
  it('adopts the owning tab when a split pane is revealed before its panes mount (#10486)', async () => {
    // Unmounted worktrees retain split PTYs only in layout; live maps may be empty.
    const storeState: HarnessStoreState = createHarnessStoreState({
      tabsByWorktree: { [WORKTREE_ID]: [{ id: 'tab-split', ptyId: 'pty-a', title: 'codex' }] },
      ptyIdsByTabId: {},
      terminalLayoutsByTabId: {
        'tab-split': { ptyIdsByLeafId: { 'leaf-a': 'pty-a', 'leaf-b': 'pty-b' } }
      }
    })
    const harness = await loadIpcEventsHarness(storeState)
    harness.useIpcEvents()

    revealSplitPaneFromMobile(harness)

    expect(storeState.createTab).not.toHaveBeenCalled()
    expect(harness.replyTerminalCreate).toHaveBeenCalledWith({
      requestId: 'mobile-reveal',
      tabId: 'tab-split',
      title: 'codex',
      identity: revealIdentity('tab-split')
    })
  })

  it('adopts the owning tab when neither the live map nor the layout is hydrated', async () => {
    // Before layout hydration, honor the pre-minted tab ID baked into the PTY paneKey.
    const storeState: HarnessStoreState = createHarnessStoreState({
      tabsByWorktree: { [WORKTREE_ID]: [{ id: 'tab-split', ptyId: 'pty-a', title: 'codex' }] },
      ptyIdsByTabId: { 'tab-split': ['pty-a'] },
      terminalLayoutsByTabId: {}
    })
    const harness = await loadIpcEventsHarness(storeState)
    harness.useIpcEvents()

    revealSplitPaneFromMobile(harness)

    expect(storeState.createTab).not.toHaveBeenCalled()
    expect(harness.replyTerminalCreate).toHaveBeenCalledWith({
      requestId: 'mobile-reveal',
      tabId: 'tab-split',
      title: 'codex',
      identity: revealIdentity('tab-split')
    })
  })

  it('adopts the tab that records the pty when the reveal hint disagrees', async () => {
    // Dragging a pane changes its current tab while reveal still names its baked-in original.
    const storeState: HarnessStoreState = createHarnessStoreState({
      tabsByWorktree: {
        [WORKTREE_ID]: [
          { id: 'tab-detached', ptyId: null, title: 'Terminal 1' },
          { id: 'tab-split', ptyId: 'pty-a', title: 'codex' }
        ]
      },
      ptyIdsByTabId: { 'tab-split': ['pty-a'] },
      terminalLayoutsByTabId: {
        'tab-detached': { ptyIdsByLeafId: { 'leaf-b': 'pty-b' } },
        'tab-split': { ptyIdsByLeafId: { 'leaf-a': 'pty-a' } }
      }
    })
    const harness = await loadIpcEventsHarness(storeState)
    harness.useIpcEvents()

    revealSplitPaneFromMobile(harness)

    expect(storeState.createTab).not.toHaveBeenCalled()
    expect(harness.replyTerminalCreate).toHaveBeenCalledWith({
      requestId: 'mobile-reveal',
      tabId: 'tab-detached',
      title: 'codex',
      identity: revealIdentity('tab-detached')
    })
  })

  it('adopts through the persisted layout when the PTY carries no tab id', async () => {
    const storeState: HarnessStoreState = createHarnessStoreState({
      tabsByWorktree: { [WORKTREE_ID]: [{ id: 'tab-split', ptyId: 'pty-a', title: 'codex' }] },
      ptyIdsByTabId: {},
      terminalLayoutsByTabId: {
        'tab-split': { ptyIdsByLeafId: { 'leaf-a': 'pty-a', 'leaf-b': 'pty-b' } }
      }
    })
    const harness = await loadIpcEventsHarness(storeState)
    harness.useIpcEvents()

    harness.createTerminal({
      requestId: 'mobile-reveal',
      worktreeId: WORKTREE_ID,
      ptyId: 'pty-b',
      leafId: 'leaf-b',
      presentation: 'focused',
      title: 'codex'
    })

    expect(storeState.createTab).not.toHaveBeenCalled()
    expect(harness.replyTerminalCreate).toHaveBeenCalledWith({
      requestId: 'mobile-reveal',
      tabId: 'tab-split',
      title: 'codex'
    })
  })

  it('keeps a live binding authoritative over a stale layout row', async () => {
    // No tabId hint: the live pty map still pins the session to its real tab.
    const storeState: HarnessStoreState = createHarnessStoreState({
      tabsByWorktree: {
        [WORKTREE_ID]: [
          { id: 'tab-stale', ptyId: null, title: 'Terminal 1' },
          { id: 'tab-live', ptyId: null, title: 'codex' }
        ]
      },
      ptyIdsByTabId: { 'tab-live': ['pty-b'] },
      terminalLayoutsByTabId: { 'tab-stale': { ptyIdsByLeafId: { 'leaf-x': 'pty-b' } } }
    })
    const harness = await loadIpcEventsHarness(storeState)
    harness.useIpcEvents()

    harness.createTerminal({
      requestId: 'mobile-reveal',
      worktreeId: WORKTREE_ID,
      ptyId: 'pty-b',
      leafId: 'leaf-b',
      presentation: 'focused',
      title: 'codex'
    })

    expect(storeState.createTab).not.toHaveBeenCalled()
    expect(harness.replyTerminalCreate).toHaveBeenCalledWith({
      requestId: 'mobile-reveal',
      tabId: 'tab-live',
      title: 'codex'
    })
  })

  it('leaves the hinted tab split intact when the pty lives in another tab', async () => {
    // Hint adoption must not overwrite a split layout with a single-pane snapshot.
    const storeState: HarnessStoreState = createHarnessStoreState({
      tabsByWorktree: {
        [WORKTREE_ID]: [
          { id: 'tab-split', ptyId: null, title: 'codex' },
          { id: 'tab-detached', ptyId: null, title: 'Terminal 2' }
        ]
      },
      ptyIdsByTabId: {},
      terminalLayoutsByTabId: {
        'tab-split': {
          root: {
            type: 'split',
            direction: 'horizontal',
            first: { type: 'leaf', leafId: 'leaf-1' },
            second: { type: 'leaf', leafId: 'leaf-2' }
          },
          ptyIdsByLeafId: { 'leaf-1': 'pty-1', 'leaf-2': 'pty-2' }
        },
        'tab-detached': { ptyIdsByLeafId: { 'leaf-b': 'pty-b' } }
      }
    })

    const harness = await loadIpcEventsHarness(storeState)
    harness.useIpcEvents()

    revealSplitPaneFromMobile(harness)

    expect(storeState.createTab).not.toHaveBeenCalled()
    const layoutWrites = (storeState.setTabLayout as { mock: { calls: unknown[][] } }).mock.calls
    expect(layoutWrites.map((call) => call[0])).not.toContain('tab-split')
    expect(harness.replyTerminalCreate).toHaveBeenCalledWith({
      requestId: 'mobile-reveal',
      tabId: 'tab-detached',
      title: 'codex',
      identity: revealIdentity('tab-detached')
    })
  })

  it('replies without an error when two recorded bindings both claim the pty', async () => {
    // Ambiguous ownership creates a new tab without rejecting mobile’s uncaught focus request.
    const storeState: HarnessStoreState = createHarnessStoreState({
      tabsByWorktree: {
        [WORKTREE_ID]: [
          { id: 'tab-stale-a', ptyId: 'pty-b', title: 'Terminal 1' },
          { id: 'tab-stale-b', ptyId: null, title: 'Terminal 2' }
        ]
      },
      ptyIdsByTabId: {},
      terminalLayoutsByTabId: { 'tab-stale-b': { ptyIdsByLeafId: { 'leaf-y': 'pty-b' } } }
    })
    const harness = await loadIpcEventsHarness(storeState)
    harness.useIpcEvents()

    harness.createTerminal({
      requestId: 'mobile-reveal',
      worktreeId: WORKTREE_ID,
      ptyId: 'pty-b',
      leafId: 'leaf-b',
      presentation: 'focused',
      title: 'codex'
    })

    expect(harness.replyTerminalCreate).toHaveBeenCalledWith({
      requestId: 'mobile-reveal',
      tabId: 'tab-minted',
      title: 'codex'
    })
  })
})
