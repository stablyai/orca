import { beforeEach, describe, expect, it, vi } from 'vitest'

type GoToToast = { title: string; onClick: () => void }
type KnownWorktree = {
  id: string
  repoId: string
  displayName: string
  branch: string
  path: string
}

const mocks = vi.hoisted(() => {
  const toasts: GoToToast[] = []
  const known: { worktree: KnownWorktree | undefined } = { worktree: undefined }
  return {
    toasts,
    known,
    activateAndRevealWorktree: vi.fn(),
    activateTabAndFocusPane: vi.fn()
  }
})

vi.mock('sonner', () => ({
  toast: {
    success: (title: string, options: { action: { onClick: () => void } }) => {
      mocks.toasts.push({ title, onClick: options.action.onClick })
    }
  }
}))
vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => ({
      repos: [{ id: 'repo-1', kind: 'git' }],
      getKnownWorktreeById: () => mocks.known.worktree
    })
  }
}))
vi.mock('@/lib/worktree-activation', () => ({
  activateAndRevealWorktree: mocks.activateAndRevealWorktree
}))
vi.mock('@/lib/activate-tab-and-focus-pane', () => ({
  activateTabAndFocusPane: mocks.activateTabAndFocusPane
}))
vi.mock('@/lib/agent-catalog', () => ({ getAgentLabel: () => 'Claude Code' }))

import { showAgentLaunchStartedElsewhereNotice } from './agent-launch-started-elsewhere-notice'

beforeEach(() => {
  vi.clearAllMocks()
  mocks.toasts.length = 0
  mocks.known.worktree = {
    id: 'wt-1',
    repoId: 'repo-1',
    displayName: 'Feature',
    branch: 'refs/heads/feature',
    path: '/workspace/feature'
  }
})

describe('showAgentLaunchStartedElsewhereNotice', () => {
  it('names the agent and workspace, and its Go-to opens the workspace then focuses the tab', () => {
    showAgentLaunchStartedElsewhereNotice({
      agent: 'claude',
      worktreeId: 'wt-1',
      tab: { tabId: 'tab-a', leafId: 'leaf-a' }
    })

    expect(mocks.toasts).toHaveLength(1)
    expect(mocks.toasts[0]?.title).toBe('Claude Code started in Feature')
    expect(mocks.activateAndRevealWorktree).not.toHaveBeenCalled()

    mocks.toasts[0]?.onClick()

    expect(mocks.activateAndRevealWorktree).toHaveBeenCalledWith('wt-1', {
      sidebarRevealBehavior: 'auto',
      navigationIntent: 'user-open'
    })
    expect(mocks.activateTabAndFocusPane).toHaveBeenCalledWith('tab-a', 'leaf-a')
    expect(mocks.activateAndRevealWorktree.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.activateTabAndFocusPane.mock.invocationCallOrder[0]!
    )
  })

  it('focuses nothing when the workspace could not be opened', () => {
    mocks.activateAndRevealWorktree.mockReturnValue(false)
    showAgentLaunchStartedElsewhereNotice({
      agent: 'claude',
      worktreeId: 'wt-1',
      tab: { tabId: 'tab-a', leafId: 'leaf-a' }
    })

    mocks.toasts[0]?.onClick()

    expect(mocks.activateTabAndFocusPane).not.toHaveBeenCalled()
  })

  it('only opens the workspace for a launch that named no terminal tab', () => {
    showAgentLaunchStartedElsewhereNotice({ agent: 'claude', worktreeId: 'wt-1' })

    mocks.toasts[0]?.onClick()

    expect(mocks.activateAndRevealWorktree).toHaveBeenCalledOnce()
    expect(mocks.activateTabAndFocusPane).not.toHaveBeenCalled()
  })

  it('stays quiet for a workspace that no longer exists', () => {
    mocks.known.worktree = undefined

    showAgentLaunchStartedElsewhereNotice({ agent: 'claude', worktreeId: 'wt-gone' })

    expect(mocks.toasts).toHaveLength(0)
  })
})
