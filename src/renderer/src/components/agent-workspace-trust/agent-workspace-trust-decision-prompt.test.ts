import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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
  AGENT_TRUST_PROMPT_TIMEOUT_MS,
  AGENT_TRUST_SAVE_WAIT_MS,
  answerAgentWorkspaceTrustDecision,
  awaitAgentWorkspaceTrustDecision,
  getAgentWorkspaceTrustDecisionRequest,
  subscribeAgentWorkspaceTrustDecisionRequest
} from './agent-workspace-trust-decision-prompt'

const WORKTREE = 'repo-1::/repos/app/feature'
const launch = (workspaceId = WORKTREE) =>
  awaitAgentWorkspaceTrustDecision({ launchAgent: 'claude', workspaceId, connectionId: null })

let unsubscribeDialog: () => void = () => {}

beforeEach(() => {
  vi.useFakeTimers()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  unsubscribeDialog = subscribeAgentWorkspaceTrustDecisionRequest(() => {})
  state.repos = [{ id: 'repo-1', path: '/repos/app', displayName: 'app' }]
  state.settings = { agentWorkspaceTrustEnabled: true }
  state.updateRepo = vi.fn(async (repoId: string, updates: Partial<Repo>) => {
    state.repos = state.repos.map((repo) => (repo.id === repoId ? { ...repo, ...updates } : repo))
    return true
  })
})

afterEach(async () => {
  // Release anything a test left on screen so module state never leaks between tests.
  await vi.advanceTimersByTimeAsync(AGENT_TRUST_PROMPT_TIMEOUT_MS)
  unsubscribeDialog()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('first agent launch in a repo', () => {
  it('holds the launch until answered, asking once for all its worktrees', async () => {
    const first = launch()
    const second = launch('repo-1::/repos/app/other')
    expect(first).not.toBeNull()
    expect(second).toBe(first)
    expect(getAgentWorkspaceTrustDecisionRequest()?.repoName).toBe('app')

    await answerAgentWorkspaceTrustDecision('agent-asks')

    await expect(first).resolves.toBe('agent-asks')
    expect(state.updateRepo).toHaveBeenCalledWith(
      'repo-1',
      { agentWorkspaceTrust: 'agent-asks' },
      { hostId: 'local' }
    )
    expect(getAgentWorkspaceTrustDecisionRequest()).toBeNull()
    expect(launch()).toBeNull()
  })

  it('releases with the answer when saving fails, and asks again next time', async () => {
    state.updateRepo = vi.fn(async () => false)
    const pending = launch()

    await answerAgentWorkspaceTrustDecision('agent-asks')

    await expect(pending).resolves.toBe('agent-asks')
    expect(launch()).not.toBeNull()
  })

  it('releases with the answer when saving stalls', async () => {
    state.updateRepo = vi.fn(() => new Promise<boolean>(() => {}))
    const pending = launch()

    const answered = answerAgentWorkspaceTrustDecision('agent-asks')
    await vi.advanceTimersByTimeAsync(AGENT_TRUST_SAVE_WAIT_MS)
    await answered

    await expect(pending).resolves.toBe('agent-asks')
  })

  it("releases an unanswered prompt with today's default and closes it", async () => {
    const pending = launch()

    await vi.advanceTimersByTimeAsync(AGENT_TRUST_PROMPT_TIMEOUT_MS)

    await expect(pending).resolves.toBeNull()
    expect(getAgentWorkspaceTrustDecisionRequest()).toBeNull()
    expect(state.updateRepo).not.toHaveBeenCalled()
  })

  it('never holds a launch when no dialog is mounted to answer it', () => {
    unsubscribeDialog()
    expect(launch()).toBeNull()
  })

  it('does not ask when folder trust is off globally', () => {
    state.settings = { agentWorkspaceTrustEnabled: false }
    expect(launch()).toBeNull()
  })

  it('does not ask for folder workspaces, which have no repo to remember the answer', () => {
    expect(launch('folder:abc')).toBeNull()
  })
})
