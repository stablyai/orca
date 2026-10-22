import { afterEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { findCmdJTaskWorkspace, openCmdJTask } from './task-search-activation'
import { jiraTaskIssue, jiraTaskSource, jiraTaskResult } from './task-search.test-fixture'
import { makeWorktree, makeFolderWorkspace } from '../worktree-jump-palette-test-fixtures'
import { getFolderWorkspaceWorktree } from '@/store/slices/worktrees/listing/detected-worktree-meta'

const initial = useAppStore.getInitialState()
afterEach(() => useAppStore.setState(initial, true))
const attachment = {
  provider: 'jira' as const,
  type: 'issue' as const,
  number: 0,
  url: jiraTaskIssue.url,
  jiraIdentifier: jiraTaskIssue.key,
  taskSourceContext: jiraTaskSource
}

it('uses the attachment source owner when a workspace executes on a different host', () => {
  const workspace = makeWorktree('remote', 'Jira workspace', {
    hostId: 'runtime:runner',
    linkedItems: [attachment]
  })
  expect(findCmdJTaskWorkspace(jiraTaskResult, [workspace])).toBe(workspace)
})

it('rejects source host/account/site collisions even when the issue URL matches', () => {
  for (const source of [
    { ...jiraTaskSource, hostId: 'runtime:other' as const },
    // Another login on the same site has its own siteId.
    {
      ...jiraTaskSource,
      providerIdentity: {
        provider: 'jira' as const,
        siteId: 'other-site-second-login',
        siteUrl: 'https://other.atlassian.net',
        projectKey: 'DEMO'
      }
    },
    {
      ...jiraTaskSource,
      providerIdentity: {
        provider: 'jira' as const,
        siteId: 'different-site',
        siteUrl: 'https://other.atlassian.net',
        projectKey: 'DEMO'
      }
    }
  ]) {
    const workspace = makeWorktree('wrong', 'Wrong source', {
      linkedItems: [{ ...attachment, taskSourceContext: source }]
    })
    expect(findCmdJTaskWorkspace(jiraTaskResult, [workspace])).toBeUndefined()
  }
})

it('treats the Jira account label as display-only', () => {
  const workspace = makeWorktree('labeled', 'Display name label', {
    linkedItems: [
      { ...attachment, taskSourceContext: { ...jiraTaskSource, accountLabel: 'Other' } }
    ]
  })
  expect(findCmdJTaskWorkspace(jiraTaskResult, [workspace])).toBe(workspace)
})

it('rejects bare legacy identifiers and other Jira origins', () => {
  const bare = makeWorktree('bare', 'Unscoped', {
    linkedWorkItem: {
      provider: 'jira',
      type: 'issue',
      number: 0,
      title: '',
      url: '',
      jiraIdentifier: jiraTaskIssue.key
    }
  })
  const wrongSite = makeWorktree('wrong', 'Other site', {
    linkedItems: [{ ...attachment, url: 'https://wrong.atlassian.net/browse/DEMO-12' }]
  })
  expect(findCmdJTaskWorkspace(jiraTaskResult, [bare, wrongSite])).toBeUndefined()
})

it('matches linked folder workspaces and excludes archives', () => {
  const folder = getFolderWorkspaceWorktree(
    makeFolderWorkspace({
      linkedTask: {
        provider: 'jira',
        type: 'issue',
        number: 0,
        title: jiraTaskIssue.title,
        url: jiraTaskIssue.url,
        jiraIdentifier: jiraTaskIssue.key
      },
      linkedTaskSourceContext: jiraTaskSource
    })
  )
  expect(findCmdJTaskWorkspace(jiraTaskResult, [folder])).toBe(folder)
  expect(findCmdJTaskWorkspace(jiraTaskResult, [{ ...folder, isArchived: true }])).toBeUndefined()
})

it('opens the existing composer with the exact task source and Jira identifier', async () => {
  const openModal = vi.fn()
  useAppStore.setState({ openModal, closeModal: vi.fn() })
  openCmdJTask(jiraTaskResult, true)
  await Promise.resolve()
  expect(openModal).toHaveBeenCalledWith(
    'new-workspace-composer',
    expect.objectContaining({
      linkedWorkItem: expect.objectContaining({
        jiraIdentifier: jiraTaskIssue.key,
        url: jiraTaskIssue.url
      }),
      taskSourceContext: jiraTaskSource,
      telemetrySource: 'command_palette'
    })
  )
})
