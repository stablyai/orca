// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  activateAndRevealWorkspace: vi.fn(() => ({ primaryTabId: 'tab-1' }) as unknown),
  activateTabAndFocusPane: vi.fn(),
  tabsByWorktree: {} as Record<string, { id: string }[]>
}))

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => ({ tabsByWorktree: mocks.tabsByWorktree })
  }
}))

vi.mock('@/lib/worktree-activation', () => ({
  activateAndRevealWorkspace: mocks.activateAndRevealWorkspace
}))

vi.mock('@/lib/activate-tab-and-focus-pane', () => ({
  activateTabAndFocusPane: mocks.activateTabAndFocusPane
}))

import { revealAgentPane } from './reveal-agent-pane'

describe('revealAgentPane', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.activateAndRevealWorkspace.mockReturnValue({ primaryTabId: 'tab-1' })
    mocks.tabsByWorktree = { 'wt-1': [{ id: 'tab-1' }], 'folder:folder-1': [{ id: 'tab-2' }] }
  })

  // The whole point of the helper: activateAndRevealWorkspace is what runs
  // resumeSleepingAgentSessionsForWorktree, so a slept agent wakes on the way in.
  it('activates through worktree-activation rather than the raw store setter', () => {
    expect(revealAgentPane({ worktreeId: 'wt-1', tabId: 'tab-1', leafId: 'leaf-1' })).toBe(true)

    expect(mocks.activateAndRevealWorkspace).toHaveBeenCalledWith('wt-1', {})
    expect(mocks.activateTabAndFocusPane).toHaveBeenCalledWith('tab-1', 'leaf-1', {})
  })

  it('forwards the execution host so a colliding worktree id resolves', () => {
    revealAgentPane({
      worktreeId: 'wt-1',
      tabId: 'tab-1',
      leafId: 'leaf-1',
      executionHostId: 'runtime:env-1'
    })

    expect(mocks.activateAndRevealWorkspace).toHaveBeenCalledWith('wt-1', {
      executionHostId: 'runtime:env-1'
    })
  })

  it('requests only the selected retained card and focuses its replacement tab', () => {
    mocks.activateAndRevealWorkspace.mockReturnValue({
      primaryTabId: 'shell-tab',
      resumedAgentTabId: 'resumed-tab'
    })
    mocks.tabsByWorktree = { 'wt-1': [{ id: 'shell-tab' }, { id: 'resumed-tab' }] }

    expect(
      revealAgentPane({
        worktreeId: 'wt-1',
        tabId: 'closed-tab',
        leafId: 'closed-leaf',
        paneKey: 'closed-tab:closed-leaf'
      })
    ).toBe(true)

    expect(mocks.activateAndRevealWorkspace).toHaveBeenCalledWith('wt-1', {
      resumeCompletedPaneKey: 'closed-tab:closed-leaf'
    })
    expect(mocks.activateTabAndFocusPane).toHaveBeenCalledWith('resumed-tab', null, {})
  })

  // Dashboard/agent-map cards carry `folder:<id>` in worktreeId; the dispatcher
  // inside activateAndRevealWorkspace is what routes those to the folder path.
  it('passes a folder workspace key straight through to the dispatcher', () => {
    expect(revealAgentPane({ worktreeId: 'folder:folder-1', tabId: 'tab-2', leafId: null })).toBe(
      true
    )

    expect(mocks.activateAndRevealWorkspace).toHaveBeenCalledWith('folder:folder-1', {})
    expect(mocks.activateTabAndFocusPane).toHaveBeenCalledWith('tab-2', null, {})
  })

  it('still activates the tab when the card carries no leaf', () => {
    revealAgentPane({ worktreeId: 'wt-1', tabId: 'tab-1', leafId: null })

    expect(mocks.activateTabAndFocusPane).toHaveBeenCalledWith('tab-1', null, {})
  })

  it('forwards the ack, flash and scroll options', () => {
    revealAgentPane(
      { worktreeId: 'wt-1', tabId: 'tab-1', leafId: 'leaf-1' },
      {
        ackPaneKeyOnSuccess: 'pane-1',
        flashFocusedPane: true,
        scrollToBottomIfOutputSinceLastView: true
      }
    )

    expect(mocks.activateTabAndFocusPane).toHaveBeenCalledWith('tab-1', 'leaf-1', {
      ackPaneKeyOnSuccess: 'pane-1',
      flashFocusedPane: true,
      scrollToBottomIfOutputSinceLastView: true
    })
  })

  // Waking a slept agent can append a fresh `--resume` tab instead of reviving the
  // husk; focusing the dead id would yank the user off the tab the wake just opened.
  it('does not focus a tab that the wake replaced', () => {
    const onTargetUnavailable = vi.fn()

    expect(
      revealAgentPane(
        { worktreeId: 'wt-1', tabId: 'husk-tab', leafId: 'leaf-1' },
        { onTargetUnavailable }
      )
    ).toBe(false)

    expect(mocks.activateAndRevealWorkspace).toHaveBeenCalledTimes(1)
    expect(mocks.activateTabAndFocusPane).not.toHaveBeenCalled()
    expect(onTargetUnavailable).toHaveBeenCalledTimes(1)
  })

  // A folder workspace whose path is missing/unmounted toasts and returns false;
  // the sidebar leans on this to drop the stale agent row.
  it('reports unavailable when activation itself refuses', () => {
    mocks.activateAndRevealWorkspace.mockReturnValue(false)
    const onTargetUnavailable = vi.fn()

    expect(
      revealAgentPane(
        { worktreeId: 'wt-1', tabId: 'tab-1', leafId: 'leaf-1' },
        { onTargetUnavailable }
      )
    ).toBe(false)

    expect(mocks.activateTabAndFocusPane).not.toHaveBeenCalled()
    expect(onTargetUnavailable).toHaveBeenCalledTimes(1)
  })
})
