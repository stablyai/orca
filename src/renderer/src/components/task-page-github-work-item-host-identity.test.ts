import { afterEach, describe, expect, it } from 'vitest'
import type { ExecutionHostId } from '../../../shared/execution-host'
import type { ParsedTaskQuery } from '../../../shared/task-query'
import type { TaskSourceContext } from '../../../shared/task-source-context'
import type { GitHubWorkItem } from '../../../shared/types'
import {
  applyPendingTaskPageGitHubMutationsToItems,
  beginTaskPageGitHubWorkItemMutation,
  materializeTaskPageItemList
} from './task-page-github-work-item-mutations'
import { resetTaskPageGitHubMutationRegistryForTests } from './task-page-github-work-item-mutation-registry'

const query: ParsedTaskQuery = {
  scope: 'all',
  state: 'open',
  draft: false,
  assignee: null,
  author: null,
  reviewRequested: null,
  reviewedBy: null,
  labels: [],
  freeText: ''
}

function item(repoExecutionHostId: ExecutionHostId): GitHubWorkItem {
  return {
    id: 'issue:1',
    type: 'issue',
    number: 1,
    title: repoExecutionHostId,
    state: 'open',
    url: 'https://github.com/o/r/issues/1',
    labels: [],
    updatedAt: '2026-01-01T00:00:00Z',
    author: 'author',
    repoId: 'repo-1',
    repoExecutionHostId
  }
}

function sourceContext(hostId: ExecutionHostId): TaskSourceContext {
  return {
    kind: 'task-source',
    provider: 'github',
    projectId: 'project-1',
    hostId,
    repoId: 'repo-1'
  }
}

afterEach(() => resetTaskPageGitHubMutationRegistryForTests())

describe('TaskPage GitHub work-item host identity', () => {
  it('does not apply an SSH pending mutation to a local item with colliding ids', () => {
    const local = item('local')
    const ssh = item('ssh:ssh-1')
    beginTaskPageGitHubWorkItemMutation({
      item: ssh,
      intent: { type: 'setState', state: 'closed' },
      sourceContext: sourceContext('ssh:ssh-1'),
      query,
      queryKey: 'q',
      viewerLogin: 'me',
      patchWorkItem: () => {}
    })

    expect(
      applyPendingTaskPageGitHubMutationsToItems([local, ssh]).map((entry) => entry.state)
    ).toEqual(['open', 'closed'])
  })

  it('keys the optimistic overlay by the item owner when source context differs', () => {
    const local = item('local')
    beginTaskPageGitHubWorkItemMutation({
      item: local,
      intent: { type: 'setState', state: 'closed' },
      sourceContext: sourceContext('runtime:r-1'),
      query,
      queryKey: 'q',
      viewerLogin: 'me',
      patchWorkItem: () => {}
    })

    expect(applyPendingTaskPageGitHubMutationsToItems([local])[0]?.state).toBe('closed')
  })

  it('retains same-id work items owned by different execution hosts', () => {
    const rows = materializeTaskPageItemList({
      networkItems: [item('local'), item('ssh:ssh-1')],
      previousItems: [],
      queryKey: 'q'
    })

    expect(rows.map((entry) => entry.repoExecutionHostId).sort()).toEqual(['local', 'ssh:ssh-1'])
  })
})
