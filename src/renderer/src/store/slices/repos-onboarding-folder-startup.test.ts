import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultOnboardingState, getDefaultSettings } from '../../../../shared/constants'
import { createTestStore, makeWorktree } from './store-test-helpers'

const worktreeActivation = vi.hoisted(() => ({
  activateAndRevealWorktree: vi.fn()
}))

vi.mock('../../lib/worktree-activation', () => ({
  activateAndRevealWorktree: worktreeActivation.activateAndRevealWorktree
}))

const reposAdd = vi.fn()
const worktreesList = vi.fn()
const onboardingGet = vi.fn()
const onboardingUpdate = vi.fn()

beforeEach(() => {
  reposAdd.mockReset()
  worktreesList.mockReset()
  onboardingGet.mockReset()
  onboardingUpdate.mockReset()
  worktreeActivation.activateAndRevealWorktree.mockReset()
  vi.stubGlobal('window', {
    api: {
      repos: { add: reposAdd },
      worktrees: { list: worktreesList },
      onboarding: { get: onboardingGet, update: onboardingUpdate }
    }
  })
})

describe('repo slice skipped-onboarding folder startup', () => {
  it('only seeds the onboarding default agent for the first dismissed-onboarding folder', async () => {
    reposAdd
      .mockResolvedValueOnce({
        repo: { id: 'folder-1', path: '/first', displayName: 'First', addedAt: 1 }
      })
      .mockResolvedValueOnce({
        repo: { id: 'folder-2', path: '/second', displayName: 'Second', addedAt: 2 }
      })
    worktreesList.mockImplementation(({ repoId }: { repoId: string }) => [
      makeWorktree({ id: `${repoId}::/folder`, repoId })
    ])
    onboardingGet.mockResolvedValue({ ...getDefaultOnboardingState(), outcome: 'dismissed' })
    const store = createTestStore()
    store.setState({
      settings: {
        ...getDefaultSettings('/tmp/orca-workspaces'),
        defaultTuiAgent: 'codex'
      }
    })

    await store.getState().addNonGitFolder('/first')
    await store.getState().addNonGitFolder('/second')

    expect(worktreeActivation.activateAndRevealWorktree).toHaveBeenNthCalledWith(
      1,
      'folder-1::/folder',
      {
        sidebarRevealBehavior: 'auto',
        startup: {
          command: "codex '--dangerously-bypass-approvals-and-sandbox'",
          env: {},
          launchAgent: 'codex',
          launchConfig: {
            agentCommand: "codex '--dangerously-bypass-approvals-and-sandbox'",
            agentArgs: '--dangerously-bypass-approvals-and-sandbox',
            agentEnv: {}
          },
          sessionOptions: undefined,
          telemetry: {
            agent_kind: 'codex',
            launch_source: 'onboarding',
            request_kind: 'new'
          }
        }
      }
    )
    expect(worktreeActivation.activateAndRevealWorktree).toHaveBeenNthCalledWith(
      2,
      'folder-2::/folder',
      { sidebarRevealBehavior: 'auto' }
    )
  })

  it('shows the terminal welcome for the first folder after completed onboarding', async () => {
    reposAdd.mockResolvedValue({
      repo: {
        id: 'folder-1',
        path: '/first',
        displayName: 'First',
        addedAt: 1,
        kind: 'folder'
      }
    })
    worktreesList.mockResolvedValue([makeWorktree({ id: 'folder-1::/first', repoId: 'folder-1' })])
    onboardingGet.mockResolvedValue({
      ...getDefaultOnboardingState(),
      closedAt: 1,
      outcome: 'completed'
    })
    worktreeActivation.activateAndRevealWorktree.mockReturnValue({ primaryTabId: 'terminal-1' })
    const store = createTestStore()

    await store.getState().addNonGitFolder('/first')

    expect(onboardingUpdate).toHaveBeenCalledWith({ checklist: { addedFolder: true } })
    expect(store.getState().firstProjectTerminalWelcomeTabId).toBe('terminal-1')
  })
})
