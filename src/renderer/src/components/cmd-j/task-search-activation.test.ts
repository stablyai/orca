import { afterEach, expect, it } from 'vitest'
import { useAppStore } from '@/store'
import { findCmdJTaskWorkspace } from './task-search-activation'
import { jiraTaskIssue, jiraTaskSource, jiraTaskResult } from './task-search.test-fixture'
import { makeWorktree } from '../worktree-jump/worktree-jump-palette-test-fixtures'

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
