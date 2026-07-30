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
    // Desktop has the worktree closed: no pane is mounted, so the live pty map is
    // empty and only the persisted layout still records the second leaf's pty.
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
    // Same reveal, but layout hydration has not landed either; the pre-minted
    // tabId hint is the PTY's baked-in pane key and must still be honoured.
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
    // The pane was dragged out of tab-split since the PTY's env was baked, so
    // the reveal still names tab-split while tab-detached is where it now lives.
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
    // Adopting the hinted tab here would rewrite its layout with a single-pane
    // snapshot, silently collapsing the user's split onto the revealed pty.
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
    // Ambiguity is unresolvable, so the reveal still creates a tab — but it must
    // not reject, because the mobile focus path awaits it with no catch.
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
