import { beforeEach, describe, expect, it, vi } from 'vitest'
import { structuredAgentSessionTabId } from '../../../../shared/structured-agent-session-projection'

const mocks = vi.hoisted(() => ({
  activateAndRevealWorkspace: vi.fn(),
  activateTabAndFocusPane: vi.fn(),
  activateStructuredAgentSessionTab: vi.fn(),
  activateStructuredAgentSessionById: vi.fn(),
  activateAiVaultStructuredSession: vi.fn()
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

vi.mock('@/lib/activate-ai-vault-structured-session', () => ({
  activateAiVaultStructuredSession: mocks.activateAiVaultStructuredSession
}))

import { revealDashboardAgent } from './reveal-dashboard-agent'

describe('revealDashboardAgent', () => {
  beforeEach(() => {
    mocks.activateAndRevealWorkspace.mockReset().mockReturnValue(true)
    mocks.activateTabAndFocusPane.mockReset()
    mocks.activateStructuredAgentSessionTab.mockReset().mockReturnValue(true)
    mocks.activateStructuredAgentSessionById.mockReset().mockReturnValue(true)
    mocks.activateAiVaultStructuredSession.mockReset().mockResolvedValue(true)
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
    expect(mocks.activateAiVaultStructuredSession).not.toHaveBeenCalled()
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
    expect(mocks.activateAiVaultStructuredSession).not.toHaveBeenCalled()
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
    expect(mocks.activateAiVaultStructuredSession).not.toHaveBeenCalled()
  })

  it('reports success only after an unmounted host-owned chat is actually activated', async () => {
    mocks.activateStructuredAgentSessionById.mockReturnValue(false)
    mocks.activateStructuredAgentSessionTab.mockReturnValue(false)
    let resolveActivation: ((active: boolean) => void) | undefined
    const activation = new Promise<boolean>((resolve) => {
      resolveActivation = resolve
    })
    mocks.activateAiVaultStructuredSession.mockReturnValue(activation)

    const opened = revealDashboardAgent({
      repoId: 'repo-1',
      worktreeId: 'worktree-1',
      tabId: structuredAgentSessionTabId('session-1'),
      leafId: null,
      surfaceKind: 'structured-chat'
    })

    expect(opened).toBe(activation)
    expect(mocks.activateAiVaultStructuredSession).toHaveBeenCalledWith({
      structuredSession: { workspaceId: 'worktree-1', sessionId: 'session-1' }
    })
    expect(mocks.activateTabAndFocusPane).not.toHaveBeenCalled()

    let settled = false
    void Promise.resolve(opened).then(() => {
      settled = true
    })
    await Promise.resolve()
    expect(settled).toBe(false)

    resolveActivation?.(true)
    await expect(opened).resolves.toBe(true)
  })

  it('does not report success when host republish never activates a session', async () => {
    mocks.activateStructuredAgentSessionById.mockReturnValue(false)
    mocks.activateStructuredAgentSessionTab.mockReturnValue(false)
    mocks.activateAiVaultStructuredSession.mockResolvedValue(false)

    await expect(
      revealDashboardAgent({
        repoId: 'repo-1',
        worktreeId: 'worktree-1',
        tabId: structuredAgentSessionTabId('session-1'),
        leafId: null,
        surfaceKind: 'structured-chat'
      })
    ).resolves.toBe(false)

    expect(mocks.activateTabAndFocusPane).not.toHaveBeenCalled()
  })

  it('does not report success when a structured card cannot be opened', () => {
    mocks.activateStructuredAgentSessionById.mockReturnValue(false)
    mocks.activateStructuredAgentSessionTab.mockReturnValue(false)

    expect(
      revealDashboardAgent({
        repoId: 'repo-1',
        worktreeId: 'worktree-1',
        tabId: 'tab-1',
        leafId: null,
        surfaceKind: 'structured-chat'
      })
    ).toBe(false)

    expect(mocks.activateAiVaultStructuredSession).not.toHaveBeenCalled()
    expect(mocks.activateTabAndFocusPane).not.toHaveBeenCalled()
  })
})
