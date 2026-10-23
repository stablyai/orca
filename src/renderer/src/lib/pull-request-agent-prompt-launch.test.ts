import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as ExecutionHostFactsModule from '@/lib/execution-host-facts'
import type { GitHubWorkItem } from '../../../shared/github/work-item-types'
import type { PullRequestAgentPromptLaunchArgs } from './pull-request-agent-prompt-launch'

const mocks = vi.hoisted(() => {
  const settings: { defaultTuiAgent: string; disabledTuiAgents: string[] } = {
    defaultTuiAgent: 'codex',
    disabledTuiAgents: []
  }
  const store = {
    settings,
    repos: [
      {
        id: 'repo-1',
        path: '/repo',
        displayName: 'Repo',
        badgeColor: '#000000',
        addedAt: 1,
        connectionId: null
      }
    ],
    worktrees: [{ id: 'wt-1', repoId: 'repo-1', path: '/repo/wt-1' }],
    worktreesByRepo: {
      'repo-1': [{ id: 'wt-1', repoId: 'repo-1', path: '/repo/wt-1' }]
    },
    projects: [
      {
        id: 'repo-1',
        displayName: 'Repo',
        badgeColor: '#000000',
        sourceRepoIds: ['repo-1'],
        createdAt: 1,
        updatedAt: 1
      }
    ],
    allWorktrees: vi.fn(() => store.worktrees),
    ensureDetectedAgents: vi.fn(),
    ensureRemoteDetectedAgents: vi.fn()
  }
  return {
    store,
    activateAndRevealWorktree: vi.fn(),
    findGithubPrWorkspaceAttachment: vi.fn(),
    focusTerminalTabSurface: vi.fn(),
    launchAgentInNewTab: vi.fn(),
    launchWorkItemDirect: vi.fn(),
    resolveRepoWorktreeLaunchPlatform: vi.fn(),
    toastError: vi.fn()
  }
})

vi.mock('@/store', () => ({ useAppStore: { getState: () => mocks.store } }))
vi.mock('sonner', () => ({ toast: { error: mocks.toastError } }))
vi.mock('@/lib/focus-terminal-tab-surface', () => ({
  focusTerminalTabSurface: mocks.focusTerminalTabSurface
}))
vi.mock('@/lib/github-work-item-workspace-attachment', () => ({
  findGithubPrWorkspaceAttachment: mocks.findGithubPrWorkspaceAttachment
}))
vi.mock('@/lib/launch-agent-in-new-tab', () => ({ launchAgentInNewTab: mocks.launchAgentInNewTab }))
vi.mock('@/lib/launch-work-item-direct', () => ({
  launchWorkItemDirect: mocks.launchWorkItemDirect
}))
vi.mock('@/lib/worktree-activation', () => ({
  activateAndRevealWorktree: mocks.activateAndRevealWorktree
}))
vi.mock('@/lib/execution-host-facts', async () => {
  const actual = await vi.importActual<typeof ExecutionHostFactsModule>(
    '@/lib/execution-host-facts'
  )
  return {
    ...actual,
    resolveRepoWorktreeLaunchPlatform: mocks.resolveRepoWorktreeLaunchPlatform
  }
})

import { launchPullRequestAgentPrompt } from './pull-request-agent-prompt-launch'

const item: GitHubWorkItem = {
  id: 'pr-77',
  type: 'pr',
  number: 77,
  title: 'Add retry',
  state: 'open',
  url: 'https://github.com/acme/repo/pull/77',
  labels: [],
  updatedAt: '2026-10-20T00:00:00Z',
  author: 'octocat',
  repoId: 'repo-1'
}

const messages = {
  savedAgentUnavailable: () => 'saved agent unavailable',
  workspaceMissing: () => 'workspace missing',
  workspaceRevealFailed: () => 'reveal failed',
  noWorkspace: () => 'no workspace'
}

function launchArgs(
  overrides: Partial<PullRequestAgentPromptLaunchArgs> = {}
): PullRequestAgentPromptLaunchArgs {
  return {
    repoId: 'repo-1',
    commandInput: '/code-review https://github.com/acme/repo/pull/77',
    savedAgentId: null,
    agentArgs: '--model opus',
    item,
    launchSource: 'task_page',
    openModalFallback: vi.fn(),
    messages,
    ...overrides
  }
}

describe('launchPullRequestAgentPrompt', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.store.settings = { defaultTuiAgent: 'codex', disabledTuiAgents: [] }
    mocks.store.ensureDetectedAgents.mockResolvedValue(['codex'])
    mocks.findGithubPrWorkspaceAttachment.mockReturnValue(null)
    mocks.launchWorkItemDirect.mockResolvedValue(true)
    mocks.activateAndRevealWorktree.mockReturnValue(true)
    mocks.resolveRepoWorktreeLaunchPlatform.mockReturnValue('darwin')
    mocks.launchAgentInNewTab.mockImplementation(
      (args: { beforeSurfaceOpen?: () => boolean | void }) => {
        args.beforeSurfaceOpen?.()
        return { surface: { kind: 'local-terminal', tabId: 'tab-1' } }
      }
    )
  })

  it('creates a workspace for an unattached PR and submits the prompt after the agent is ready', async () => {
    const args = launchArgs()

    await expect(launchPullRequestAgentPrompt(args)).resolves.toBe(true)

    expect(mocks.launchWorkItemDirect).toHaveBeenCalledWith(
      expect.objectContaining({
        item: expect.objectContaining({ number: 77, pasteContent: args.commandInput }),
        repoId: 'repo-1',
        promptDelivery: 'submit-after-ready',
        agentArgs: '--model opus',
        agentOverride: 'codex',
        openModalFallback: args.openModalFallback
      })
    )
  })

  it('picks a detected agent for a new workspace when the default agent is blank', async () => {
    mocks.store.settings = { defaultTuiAgent: 'blank', disabledTuiAgents: [] }
    mocks.store.ensureDetectedAgents.mockResolvedValue(['claude'])

    await launchPullRequestAgentPrompt(launchArgs())

    expect(mocks.launchWorkItemDirect).toHaveBeenCalledWith(
      expect.objectContaining({ agentOverride: 'claude' })
    )
  })

  it('refuses to create a workspace when no enabled agent is detected', async () => {
    mocks.store.ensureDetectedAgents.mockResolvedValue([])

    await expect(launchPullRequestAgentPrompt(launchArgs())).resolves.toBe(false)

    expect(mocks.launchWorkItemDirect).not.toHaveBeenCalled()
    expect(mocks.toastError).toHaveBeenCalledWith(
      'No enabled AI agent was detected on this workspace host.'
    )
  })

  it('refuses to create a workspace when the saved agent is not detected', async () => {
    await expect(
      launchPullRequestAgentPrompt(launchArgs({ savedAgentId: 'claude' }))
    ).resolves.toBe(false)

    expect(mocks.launchWorkItemDirect).not.toHaveBeenCalled()
    expect(mocks.toastError).toHaveBeenCalledWith('saved agent unavailable')
  })

  it('submits the prompt in the attached workspace after the agent is ready', async () => {
    mocks.findGithubPrWorkspaceAttachment.mockReturnValue(mocks.store.worktrees[0])

    await expect(launchPullRequestAgentPrompt(launchArgs())).resolves.toBe(true)

    expect(mocks.launchWorkItemDirect).not.toHaveBeenCalled()
    expect(mocks.launchAgentInNewTab).toHaveBeenCalledWith(
      expect.objectContaining({
        agent: 'codex',
        worktreeId: 'wt-1',
        prompt: '/code-review https://github.com/acme/repo/pull/77',
        agentArgs: '--model opus',
        promptDelivery: 'submit-after-ready'
      })
    )
    expect(mocks.focusTerminalTabSurface).toHaveBeenCalledWith('tab-1')
  })

  it('refuses in the attached workspace when the saved agent is not detected there', async () => {
    mocks.findGithubPrWorkspaceAttachment.mockReturnValue(mocks.store.worktrees[0])

    await expect(
      launchPullRequestAgentPrompt(launchArgs({ savedAgentId: 'claude' }))
    ).resolves.toBe(false)

    expect(mocks.launchAgentInNewTab).not.toHaveBeenCalled()
    expect(mocks.toastError).toHaveBeenCalledWith('saved agent unavailable')
  })

  it('reports the caller message when there is neither a workspace nor a PR to create one from', async () => {
    await expect(
      launchPullRequestAgentPrompt(launchArgs({ item: undefined, openModalFallback: undefined }))
    ).resolves.toBe(false)

    expect(mocks.toastError).toHaveBeenCalledWith('no workspace')
  })
})
