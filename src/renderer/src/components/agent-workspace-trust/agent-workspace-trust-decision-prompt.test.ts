import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../../../shared/repo-types'

type StoreState = {
  repos: Partial<Repo>[]
  settings: { agentWorkspaceTrustEnabled: boolean }
  updateRepo: ReturnType<typeof vi.fn>
}

const state = vi.hoisted((): StoreState => ({
  repos: [],
  settings: { agentWorkspaceTrustEnabled: true },
  updateRepo: vi.fn()
}))

vi.mock('@/store', () => ({ useAppStore: { getState: () => state } }))

import {
  answerAgentWorkspaceTrustDecision,
  awaitAgentWorkspaceTrustDecision,
  getAgentWorkspaceTrustDecisionRequest
} from './agent-workspace-trust-decision-prompt'

const WORKTREE = 'repo-1::/repos/app/feature'

beforeEach(() => {
  state.repos = [{ id: 'repo-1', path: '/repos/app', displayName: 'app' }]
  state.settings = { agentWorkspaceTrustEnabled: true }
  state.updateRepo = vi.fn(async (repoId: string, updates: Partial<Repo>) => {
    state.repos = state.repos.map((repo) => (repo.id === repoId ? { ...repo, ...updates } : repo))
    return true
  })
})

describe('first agent launch in a repo', () => {
  it('holds the launch until the answer is saved, asking once for all its worktrees', async () => {
    const first = awaitAgentWorkspaceTrustDecision({
      launchAgent: 'claude',
      workspaceId: WORKTREE,
      connectionId: null
    })
    const second = awaitAgentWorkspaceTrustDecision({
      launchAgent: 'codex',
      workspaceId: 'repo-1::/repos/app/other',
      connectionId: null
    })
    expect(first).not.toBeNull()
    expect(second).toBe(first)
    expect(getAgentWorkspaceTrustDecisionRequest()?.repoName).toBe('app')

    await answerAgentWorkspaceTrustDecision('agent-asks')
    await first

    expect(state.updateRepo).toHaveBeenCalledWith(
      'repo-1',
      { agentWorkspaceTrust: 'agent-asks' },
      { hostId: 'local' }
    )
    expect(getAgentWorkspaceTrustDecisionRequest()).toBeNull()
    expect(
      awaitAgentWorkspaceTrustDecision({
        launchAgent: 'claude',
        workspaceId: WORKTREE,
        connectionId: null
      })
    ).toBe(null)
  })

  it('does not ask when folder trust is off globally', () => {
    state.settings = { agentWorkspaceTrustEnabled: false }
    expect(
      awaitAgentWorkspaceTrustDecision({
        launchAgent: 'claude',
        workspaceId: WORKTREE,
        connectionId: null
      })
    ).toBe(null)
  })

  it('does not ask for folder workspaces, which have no repo to remember the answer', () => {
    expect(
      awaitAgentWorkspaceTrustDecision({
        launchAgent: 'claude',
        workspaceId: 'folder:abc',
        connectionId: null
      })
    ).toBe(null)
  })
})
