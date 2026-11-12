import { describe, expect, it } from 'vitest'
import { useAppStore } from '@/store/index'
import { activateAndRevealWorktreeWithOutcome } from './worktree-activation'
import { registerWorktreeActivationReset } from './worktree-activation.test-fixture'
import {
  makeCreatedAgentWorktree,
  seedEmptyActivatableWorktree
} from './worktree-activation-created-agent.test-fixture'

registerWorktreeActivationReset()

describe('activating a workspace in a hidden project', () => {
  it('opens it without unhiding the project, lifting filters or queuing a sidebar reveal', () => {
    const worktree = makeCreatedAgentWorktree()
    const { revealWorktreeInSidebar } = seedEmptyActivatableWorktree(worktree)
    useAppStore.setState((state) => ({
      repos: state.repos.map((repo) => ({ ...repo, hiddenAt: 1_700_000_000_000 })),
      filterRepoIds: ['some-other-repo'],
      activeWorktreeId: null
    }))

    const outcome = activateAndRevealWorktreeWithOutcome(worktree.id)

    expect(outcome).toMatchObject({ opened: {} })
    const state = useAppStore.getState()
    expect(state.activeWorktreeId).toBe(worktree.id)
    expect(state.filterRepoIds).toEqual(['some-other-repo'])
    expect(state.repos[0]?.hiddenAt).toBe(1_700_000_000_000)
    expect(revealWorktreeInSidebar).not.toHaveBeenCalled()
  })
})
