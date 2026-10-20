import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { GitHubWorkItem } from '../../../../../shared/github/work-item-types'
import type { SourceControlCustomAction } from '../../../../../shared/source-control-custom-actions'

const mocks = vi.hoisted(() => ({
  launchPullRequestAgentPrompt: vi.fn(),
  toastError: vi.fn()
}))

vi.mock('sonner', () => ({ toast: { error: mocks.toastError } }))

vi.mock('@/lib/pull-request-agent-prompt-launch', () => ({
  launchPullRequestAgentPrompt: mocks.launchPullRequestAgentPrompt
}))

import { runPullRequestCustomAction } from './custom-action-launch'

const item: GitHubWorkItem = {
  id: 'pr-123',
  type: 'pr',
  number: 123,
  title: 'Add retry',
  state: 'open',
  url: 'https://github.com/acme/api/pull/123',
  labels: [],
  updatedAt: '2026-10-20T00:00:00Z',
  author: 'octocat',
  branchName: 'feature/retry',
  baseRefName: 'main',
  repoId: 'repo-from-item'
}

const reviewAction: SourceControlCustomAction = {
  id: 'review',
  label: 'Review',
  commandInputTemplate: '/code-review {prUrl} xhigh --comment with codex.'
}

const baseArgs = { action: reviewAction, item, openWorkspaceComposer: vi.fn() }

describe('runPullRequestCustomAction', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.launchPullRequestAgentPrompt.mockResolvedValue(true)
  })

  it('launches the rendered prompt for the selected repo with the default agent', async () => {
    await expect(runPullRequestCustomAction({ ...baseArgs, repoId: 'repo-1' })).resolves.toBe(true)

    expect(mocks.launchPullRequestAgentPrompt).toHaveBeenCalledTimes(1)
    const args = mocks.launchPullRequestAgentPrompt.mock.calls[0][0]
    expect(args).toMatchObject({
      repoId: 'repo-1',
      item: { number: 123, repoId: 'repo-1' },
      commandInput: '/code-review https://github.com/acme/api/pull/123 xhigh --comment with codex.',
      savedAgentId: null,
      agentArgs: undefined,
      launchSource: 'task_page'
    })
    expect(args.openModalFallback).toBeTypeOf('function')
  })

  it("passes the action's agent and CLI arguments", async () => {
    await runPullRequestCustomAction({
      ...baseArgs,
      action: { ...reviewAction, agentId: 'claude', agentArgs: '--model opus' },
      repoId: 'repo-1'
    })

    expect(mocks.launchPullRequestAgentPrompt).toHaveBeenCalledWith(
      expect.objectContaining({ savedAgentId: 'claude', agentArgs: '--model opus' })
    )
  })

  it('offers the workspace composer from the toast when Orca cannot create the workspace', async () => {
    const openWorkspaceComposer = vi.fn()
    await runPullRequestCustomAction({
      action: reviewAction,
      item,
      repoId: 'repo-1',
      openWorkspaceComposer
    })
    const { openModalFallback } = mocks.launchPullRequestAgentPrompt.mock.calls[0][0]

    openModalFallback()

    expect(openWorkspaceComposer).not.toHaveBeenCalled()
    const [message, options] = mocks.toastError.mock.calls[0]
    expect(message).toContain('"Review"')
    options.action.onClick()
    expect(openWorkspaceComposer).toHaveBeenCalledTimes(1)
  })

  it('refuses without launching when the prompt renders empty', async () => {
    await expect(
      runPullRequestCustomAction({
        ...baseArgs,
        action: { ...reviewAction, commandInputTemplate: '   ' },
        repoId: 'repo-1'
      })
    ).resolves.toBe(false)

    expect(mocks.launchPullRequestAgentPrompt).not.toHaveBeenCalled()
    expect(mocks.toastError).toHaveBeenCalledTimes(1)
  })

  it('refuses without launching when the pull request has no repo', async () => {
    await expect(runPullRequestCustomAction({ ...baseArgs, repoId: null })).resolves.toBe(false)

    expect(mocks.launchPullRequestAgentPrompt).not.toHaveBeenCalled()
    expect(mocks.toastError).toHaveBeenCalledTimes(1)
  })
})
