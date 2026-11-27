import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  const repos: unknown[] = []
  return { openModal: vi.fn(), toastError: vi.fn(), findGitProject: vi.fn(), repos }
})
vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => ({ repos: mocks.repos, activeRepoId: 'other', openModal: mocks.openModal })
  }
}))
vi.mock('sonner', () => ({ toast: { error: mocks.toastError } }))
vi.mock('@/lib/git-remote-project-match', () => ({ findGitProjectForSource: mocks.findGitProject }))

import { openComposerForPluginTask } from './plugin-task-start'

const repos = [
  { id: 'other', path: '/home/me/Other', displayName: 'other', badgeColor: '', addedAt: 0 },
  { id: 'local', path: '/home/me/Work/', displayName: 'work', badgeColor: '', addedAt: 0 }
]

beforeEach(() => {
  mocks.openModal.mockReset()
  mocks.toastError.mockReset()
  mocks.findGitProject.mockReset().mockReturnValue(null)
  mocks.repos = repos
})

const SOURCE = { pluginKey: 'orca-samples.roadmap', sourceId: 'plans', title: 'Roadmap' }

describe('openComposerForPluginTask', () => {
  it('prefills Create workspace from the start recipe and links the workspace back', async () => {
    const opened = await openComposerForPluginTask(
      {
        id: 'plan',
        title: 'Plan title',
        url: 'https://example.com/plan',
        start: {
          workspaceName: 'plan',
          agentPrompt: 'Implement the plan.',
          baseRef: 'main',
          projectPath: '/home/me/Work',
          sessionOptions: { model: 'opus', effort: 'max' },
          linkMetadata: { plan: 'plans/plan.md' }
        }
      },
      SOURCE
    )

    expect(opened).toBe(true)
    expect(mocks.openModal).toHaveBeenCalledWith('new-workspace-composer', {
      prefilledName: 'plan',
      initialRepoId: 'local',
      initialBaseBranch: 'main',
      initialAgentDraft: 'Implement the plan.',
      initialAgentSessionOptions: { model: 'opus', effort: 'max' },
      linkedPluginTask: {
        pluginKey: 'orca-samples.roadmap',
        sourceId: 'plans',
        itemId: 'plan',
        title: 'Plan title',
        sourceTitle: 'Roadmap',
        url: 'https://example.com/plan',
        metadata: { plan: 'plans/plan.md' }
      },
      telemetrySource: 'sidebar'
    })
  })

  it('says which project is missing instead of opening on the active one', async () => {
    const item = { id: 'plan', title: 'Plan', start: { projectPath: '/home/me/Gone' } }
    await expect(openComposerForPluginTask(item, SOURCE)).resolves.toBe(false)
    expect(mocks.openModal).not.toHaveBeenCalled()
    expect(mocks.toastError).toHaveBeenCalledWith(expect.stringContaining('/home/me/Gone'))
  })

  it('reports a project lookup that fails instead of rejecting', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    mocks.findGitProject.mockRejectedValue(new Error('remote lookup failed'))
    const item = {
      id: 'plan',
      title: 'Plan',
      start: { projectSource: 'https://example.com/a.git' }
    }
    await expect(openComposerForPluginTask(item, SOURCE)).resolves.toBe(false)
    expect(mocks.openModal).not.toHaveBeenCalled()
    expect(mocks.toastError).toHaveBeenCalledWith('remote lookup failed')
  })

  it('does nothing for an item without a start recipe', async () => {
    await expect(
      openComposerForPluginTask({ id: 'manual', title: 'Manual plan' }, SOURCE)
    ).resolves.toBe(false)
    expect(mocks.openModal).not.toHaveBeenCalled()
  })
})
