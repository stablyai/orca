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

  it('mints for an ambiguous pty whose leaf id no layout carries, leaving both splits intact', async () => {
    // Adopting a claimant here would be worse than a second tab: the bridge finds the leaf absent
    // from that tab's tree, replaces its whole layout with a single pane, and orphans the PTYs of
    // every other pane it had. Ambiguity plus an unknown leaf must mint.
    const splitLayout = (boundLeafId: string, siblingLeafId: string) => ({
      root: {
        type: 'split' as const,
        direction: 'horizontal' as const,
        first: { type: 'leaf' as const, leafId: boundLeafId },
        second: { type: 'leaf' as const, leafId: siblingLeafId }
      },
      ptyIdsByLeafId: { [boundLeafId]: 'pty-b', [siblingLeafId]: `pty-${siblingLeafId}` }
    })
    const storeState: HarnessStoreState = createHarnessStoreState({
      tabsByWorktree: {
        [WORKTREE_ID]: [
          { id: 'tab-x', ptyId: null, title: 'Terminal 1' },
          { id: 'tab-y', ptyId: null, title: 'Terminal 2' }
        ]
      },
      ptyIdsByTabId: {},
      terminalLayoutsByTabId: {
        'tab-x': splitLayout('leaf-1', 'leaf-2'),
        'tab-y': splitLayout('leaf-3', 'leaf-4')
      }
    })
    const before = structuredClone(storeState.terminalLayoutsByTabId)
    const harness = await loadIpcEventsHarness(storeState)
    harness.useIpcEvents()

    harness.createTerminal({
      requestId: 'mobile-reveal',
      worktreeId: WORKTREE_ID,
      ptyId: 'pty-b',
      leafId: 'leaf-new',
      presentation: 'focused',
      title: 'codex'
    })

    expect(storeState.createTab).toHaveBeenCalled()
    expect(storeState.terminalLayoutsByTabId['tab-x']).toEqual(before['tab-x'])
    expect(storeState.terminalLayoutsByTabId['tab-y']).toEqual(before['tab-y'])
    expect(harness.replyTerminalCreate).toHaveBeenCalledWith({
      requestId: 'mobile-reveal',
      tabId: 'tab-minted',
      title: 'codex'
    })
  })

  it('adopts through the leaf id when an ambiguous pty’s leaf is one a layout carries', async () => {
    // Ambiguity is not a reason to mint on its own: the leaf id still names exactly one pane.
    const storeState: HarnessStoreState = createHarnessStoreState({
      tabsByWorktree: {
        [WORKTREE_ID]: [
          { id: 'tab-x', ptyId: null, title: 'Terminal 1' },
          { id: 'tab-y', ptyId: null, title: 'Terminal 2' }
        ]
      },
      ptyIdsByTabId: {},
      terminalLayoutsByTabId: {
        'tab-x': { ptyIdsByLeafId: { 'leaf-1': 'pty-b' } },
        'tab-y': { ptyIdsByLeafId: { 'leaf-3': 'pty-b' } }
      }
    })
    const harness = await loadIpcEventsHarness(storeState)
    harness.useIpcEvents()

    harness.createTerminal({
      requestId: 'mobile-reveal',
      worktreeId: WORKTREE_ID,
      ptyId: 'pty-b',
      leafId: 'leaf-3',
      presentation: 'focused',
      title: 'codex'
    })

    expect(storeState.createTab).not.toHaveBeenCalled()
    expect(harness.replyTerminalCreate).toHaveBeenCalledWith({
      requestId: 'mobile-reveal',
      tabId: 'tab-y',
      title: 'codex'
    })
  })

  it('adopts the sole layout claimant now that the tab row is not an ownership tier', async () => {
    // tab-stale-a holds the pty only through its row, which no longer binds anything, so
    // tab-stale-b is the one claimant. The reply must still not reject: the mobile focus
    // path awaits it with no catch.
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
      tabId: 'tab-stale-b',
      title: 'codex'
    })
  })
})
