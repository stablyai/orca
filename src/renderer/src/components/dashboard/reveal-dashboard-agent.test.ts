import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  activateAndRevealWorkspace: vi.fn(),
  activateTabAndFocusPane: vi.fn(),
  activateStructuredAgentSessionTab: vi.fn(),
  activateStructuredAgentSessionById: vi.fn()
}))

vi.mock('@/lib/worktree-activation', () => ({
  activateAndRevealWorkspace: mocks.activateAndRevealWorkspace
}))

vi.mock('@/lib/activate-tab-and-focus-pane', () => ({
  activateTabAndFocusPane: mocks.activateTabAndFocusPane
}))

vi.mock('@/lib/structured-agent-session-tab-activation', () => ({
  activateStructuredAgentSessionTab: mocks.activateStructuredAgentSessionTab,
  activateStructuredAgentSessionById: mocks.activateStructuredAgentSessionById
}))

import { revealDashboardAgent } from './reveal-dashboard-agent'

describe('revealDashboardAgent', () => {
  beforeEach(() => {
    mocks.activateAndRevealWorkspace.mockReset().mockReturnValue(true)
    mocks.activateTabAndFocusPane.mockReset()
    mocks.activateStructuredAgentSessionTab.mockReset().mockReturnValue(true)
    mocks.activateStructuredAgentSessionById.mockReset().mockReturnValue(true)
  })

  it('keeps terminal-backed cards on the pane-focus path', () => {
    expect(
      revealDashboardAgent({
        repoId: 'repo-1',
        worktreeId: 'worktree-1',
        tabId: 'tab-1',
        leafId: 'leaf-1'
      })
    ).toBe(true)

    expect(mocks.activateTabAndFocusPane).toHaveBeenCalledWith('tab-1', 'leaf-1', {
      flashFocusedPane: true
    })
    expect(mocks.activateStructuredAgentSessionTab).not.toHaveBeenCalled()
    expect(mocks.activateStructuredAgentSessionById).not.toHaveBeenCalled()
  })

  it('opens a structured chat by session id instead of forcing a terminal pane', () => {
    expect(
      revealDashboardAgent({
        repoId: 'repo-1',
        worktreeId: 'worktree-1',
        tabId: 'tab-1',
        leafId: null,
        surfaceKind: 'structured-chat',
        structuredSessionId: 'session-1'
      })
    ).toBe(true)

    expect(mocks.activateStructuredAgentSessionById).toHaveBeenCalledWith({
      worktreeId: 'worktree-1',
      sessionId: 'session-1'
    })
    expect(mocks.activateTabAndFocusPane).not.toHaveBeenCalled()
  })

  it('falls back to the structured tab id when the session is not mounted yet', () => {
    mocks.activateStructuredAgentSessionById.mockReturnValue(false)

    expect(
      revealDashboardAgent({
        repoId: 'repo-1',
        worktreeId: 'worktree-1',
        tabId: 'tab-1',
        leafId: null,
        surfaceKind: 'structured-chat',
        structuredSessionId: 'session-1'
      })
    ).toBe(true)

    expect(mocks.activateStructuredAgentSessionTab).toHaveBeenCalledWith({
      worktreeId: 'worktree-1',
      tabId: 'tab-1'
    })
    expect(mocks.activateTabAndFocusPane).not.toHaveBeenCalled()
  })
})
