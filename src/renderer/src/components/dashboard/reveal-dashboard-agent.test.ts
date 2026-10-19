import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  activateAndRevealWorkspace: vi.fn(),
  activateTabAndFocusPane: vi.fn(),
  activateTerminalTabOnOwner: vi.fn()
}))

vi.mock('@/lib/worktree-activation', () => ({
  activateAndRevealWorkspace: mocks.activateAndRevealWorkspace
}))
vi.mock('@/lib/activate-tab-and-focus-pane', () => ({
  activateTabAndFocusPane: mocks.activateTabAndFocusPane
}))
vi.mock('@/lib/terminal-tab-owner-activation', () => ({
  activateTerminalTabOnOwner: mocks.activateTerminalTabOnOwner
}))

import { revealDashboardAgent } from './reveal-dashboard-agent'

const args = {
  repoId: 'repo-1',
  worktreeId: 'wt-1',
  executionHostId: 'runtime:env-1' as const,
  tabId: 'web-terminal-host-tab',
  leafId: '11111111-1111-4111-8111-111111111111'
}

describe('revealDashboardAgent', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("focuses the card's own tab on the workspace's owner", () => {
    mocks.activateAndRevealWorkspace.mockReturnValue(true)

    expect(revealDashboardAgent(args)).toBe(true)

    expect(mocks.activateTerminalTabOnOwner).toHaveBeenCalledWith('wt-1', args.tabId, args.leafId)
    expect(mocks.activateTabAndFocusPane).toHaveBeenCalledWith(args.tabId, args.leafId, {
      flashFocusedPane: true
    })
    // Why: the owner call captures the visible tab, so it must follow the local activation.
    expect(mocks.activateTabAndFocusPane.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.activateTerminalTabOnOwner.mock.invocationCallOrder[0]
    )
  })

  it('touches no tab when the workspace cannot be revealed', () => {
    mocks.activateAndRevealWorkspace.mockReturnValue(false)

    expect(revealDashboardAgent(args)).toBe(false)

    expect(mocks.activateTerminalTabOnOwner).not.toHaveBeenCalled()
    expect(mocks.activateTabAndFocusPane).not.toHaveBeenCalled()
  })
})
