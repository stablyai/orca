import { expect, it, vi } from 'vitest'
import { mocks } from './launch-work-item-direct-test-fixture'
import { launchWorkItemDirect } from './launch-work-item-direct'

it('delivers the project Jira template instead of the global template as an unsent draft', async () => {
  const expected = 'https://example.atlassian.net/browse/APP-12 /jira-engineer'
  mocks.ensureDetectedAgents.mockResolvedValue(['claude'])
  mocks.store.settings = {
    linkedWorkItemPromptTemplate: '/global-work {{url}}'
  }
  mocks.store.projects = [
    {
      id: 'repo:repo-1',
      displayName: 'Repo',
      badgeColor: '',
      sourceRepoIds: ['repo-1'],
      createdAt: 1,
      updatedAt: 1,
      linkedWorkItemPromptTemplate: '{{url}} /jira-engineer'
    }
  ]
  mocks.store.projectHostSetups = [
    {
      id: 'repo-1',
      projectId: 'repo:repo-1',
      repoId: 'repo-1',
      hostId: 'local',
      path: '/repo',
      displayName: 'Repo',
      setupState: 'ready',
      setupMethod: 'legacy-repo',
      createdAt: 1,
      updatedAt: 1
    }
  ]
  await expect(
    launchWorkItemDirect({
      repoId: 'repo-1',
      launchSource: 'task_page',
      openModalFallback: vi.fn(),
      agentOverride: 'claude',
      item: {
        provider: 'jira',
        type: 'issue',
        number: null,
        title: 'Fix crash',
        url: 'https://example.atlassian.net/browse/APP-12'
      }
    })
  ).resolves.toBe(true)
  expect(mocks.seedNativeChatLaunchDraft).toHaveBeenCalledWith({
    tabId: 'tab-1',
    agent: 'claude',
    text: expected,
    createdAt: expect.any(Number)
  })
  expect(mocks.seedNativeChatLaunchPrompt).not.toHaveBeenCalled()
})
