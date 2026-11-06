import { afterEach, describe, expect, it } from 'vitest'
import type { ParsedTaskQuery } from '../../../../../shared/task-query'
import type { GitHubWorkItem } from '../../../../../shared/github/work-item-types'

import {
  beginTaskPageGitHubWorkItemMutation,
  rebuildSoftHiddenFromItemsForTests
} from './task-page-github-work-item-mutations'
import { clearTaskPageGitHubAuthorityThroughGeneration } from './task-page-github-work-item-authority-refresh'
import { confirmTaskPageGitHubWorkItemMutation } from './task-page-github-work-item-mutation-lifecycle'
import { getLastConfirmedClientValue } from './task-page-github-confirmed-client-values'
import { getOrCreateQuietRevalidateState } from './task-page-github-work-item-quiet-state'
import {
  getTaskPageGitHubSoftHiddenItemKeys,
  resetTaskPageGitHubMutationRegistryForTests,
  setTaskPageGitHubMutationQueryKey
} from './task-page-github-work-item-mutation-registry'
import { taskPageGitHubItemKey } from './task-page-github-work-item-mutation-keys'

function query(): ParsedTaskQuery {
  return {
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
}

function item(overrides: Partial<GitHubWorkItem> = {}): GitHubWorkItem {
  return {
    id: 'issue:1',
    type: 'issue',
    number: 1,
    title: 't',
    state: 'open',
    url: 'https://github.com/o/r/issues/1',
    labels: [],
    updatedAt: '2026-01-01T00:00:00Z',
    author: 'author',
    repoId: 'repo-1',
    ...overrides
  }
}

afterEach(() => resetTaskPageGitHubMutationRegistryForTests())

describe('TaskPage GitHub mutation regressions', () => {
  it('does not apply an old query soft-hide after mutation completion', () => {
    const patchWorkItem = (): void => {}
    const base = item({ state: 'open' })
    const began = beginTaskPageGitHubWorkItemMutation({
      item: base,
      intent: { type: 'setState', state: 'closed' },
      query: query(),
      queryKey: 'open-query',
      viewerLogin: 'me',
      patchWorkItem
    })
    setTaskPageGitHubMutationQueryKey('current-open-query')
    confirmTaskPageGitHubWorkItemMutation(began.key, began.generation, {
      query: query(),
      queryKey: 'open-query',
      viewerLogin: 'me',
      item: base,
      patchWorkItem
    })
    expect(getTaskPageGitHubSoftHiddenItemKeys()).not.toContain(
      taskPageGitHubItemKey(base.repoId, base.id)
    )
    expect(getOrCreateQuietRevalidateState('current-open-query').dirtyGeneration).toBe(1)
    rebuildSoftHiddenFromItemsForTests({
      query: query(),
      queryKey: 'current-open-query',
      viewerLogin: 'me',
      items: [base]
    })
    expect(getTaskPageGitHubSoftHiddenItemKeys()).toContain(
      taskPageGitHubItemKey(base.repoId, base.id)
    )
  })

  it('hard refresh clears only authority that predates its request', () => {
    const patchWorkItem = (): void => {}
    const base = item({ state: 'open', autoMergeEnabled: false })
    const stateMutation = beginTaskPageGitHubWorkItemMutation({
      item: base,
      intent: { type: 'setState', state: 'closed' },
      query: query(),
      queryKey: 'q',
      viewerLogin: 'me',
      patchWorkItem
    })
    confirmTaskPageGitHubWorkItemMutation(stateMutation.key, stateMutation.generation, {
      query: query(),
      queryKey: 'q',
      viewerLogin: 'me',
      item: base,
      patchWorkItem
    })
    const fetchGeneration = getOrCreateQuietRevalidateState('q').dirtyGeneration
    const autoMergeMutation = beginTaskPageGitHubWorkItemMutation({
      item: { ...base, state: 'closed' },
      intent: { type: 'setAutoMerge', enabled: true },
      query: query(),
      queryKey: 'q',
      viewerLogin: 'me',
      patchWorkItem
    })
    confirmTaskPageGitHubWorkItemMutation(autoMergeMutation.key, autoMergeMutation.generation, {
      query: query(),
      queryKey: 'q',
      viewerLogin: 'me',
      item: { ...base, state: 'closed' },
      patchWorkItem
    })

    clearTaskPageGitHubAuthorityThroughGeneration('q', fetchGeneration)

    expect(getLastConfirmedClientValue(null, base.repoId, base.id, 'state')).toBeUndefined()
    expect(getLastConfirmedClientValue(null, base.repoId, base.id, 'autoMerge')).toBe(true)
    expect(getTaskPageGitHubSoftHiddenItemKeys()).not.toContain(
      taskPageGitHubItemKey(base.repoId, base.id)
    )
  })
})
