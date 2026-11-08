import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../../../shared/repo-types'
import {
  installIpcPtyWindow,
  restorePtySpecWindow
} from '../terminal-pane/pty-transport/ipc/pty-transport-test-harness'

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
  it.each([true, false])(
    'asks once for concurrent section launches through PTY connect (save succeeds: %s)',
    async (saveSucceeds) => {
      const originalWindow: typeof window | undefined = globalThis.window
      installIpcPtyWindow(originalWindow, {})
      if (!saveSucceeds) {
        state.updateRepo = vi.fn(async () => false)
      }
      vi.mocked(window.api.pty.spawn)
        .mockResolvedValueOnce({ id: 'section-1' })
        .mockResolvedValueOnce({ id: 'section-2' })
      const { createIpcPtyTransport } =
        await import('../terminal-pane/pty-transport/ipc/pty-transport')
      const transports = ['folder:placement', 'folder:other'].map((worktreeId) =>
        createIpcPtyTransport({
          worktreeId,
          trustWorktreeId: WORKTREE,
          cwd: '/repos/app/feature',
          command: 'claude',
          launchAgent: 'claude'
        })
      )
      const connecting = Promise.all(
        transports.map((transport) => transport.connect({ url: '', callbacks: {} }))
      )
      try {
        expect(getAgentWorkspaceTrustDecisionRequest()).toMatchObject({
          repoId: 'repo-1',
          repoName: 'app',
          hostId: 'local'
        })
        expect(window.api.pty.spawn).not.toHaveBeenCalled()
        await answerAgentWorkspaceTrustDecision('agent-asks')
        await connecting
        expect(state.updateRepo).toHaveBeenCalledExactlyOnceWith(
          'repo-1',
          { agentWorkspaceTrust: 'agent-asks' },
          { hostId: 'local' }
        )
        expect(getAgentWorkspaceTrustDecisionRequest()).toBeNull()
        expect(vi.mocked(window.api.pty.spawn).mock.calls.map(([args]) => args)).toMatchObject([
          {
            worktreeId: 'folder:placement',
            trustWorktreeId: WORKTREE,
            cwd: '/repos/app/feature',
            skipAgentWorkspaceTrust: true
          },
          {
            worktreeId: 'folder:other',
            trustWorktreeId: WORKTREE,
            cwd: '/repos/app/feature',
            skipAgentWorkspaceTrust: true
          }
        ])
      } finally {
        await answerAgentWorkspaceTrustDecision('agent-asks')
        await connecting
        for (const transport of transports) {
          transport.destroy?.()
        }
        restorePtySpecWindow(originalWindow)
      }
    }
  )

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
})
