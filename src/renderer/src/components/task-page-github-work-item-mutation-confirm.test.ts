import { afterEach, describe, expect, it } from 'vitest'
import type { GitHubWorkItem } from '../../../shared/github/work-item-types'
import { createTestStore } from '@/store/slices/github-slice-test-harness'
import { workItemsCacheKey } from '@/store/github/cache-identity'
import { resetTaskPageGitHubMutationRegistryForTests } from './task-page-github-work-item-mutation-registry'
import {
  beginTaskPageGitHubWorkItemMutation,
  confirmTaskPageGitHubWorkItemMutation
} from './task-page-github-work-item-mutations'

const bob = { login: 'bob', name: null, avatarUrl: '' }
const carol = { login: 'carol', name: null, avatarUrl: '' }
const item: GitHubWorkItem = {
  id: 'pr:1',
  repoId: 'repo-1',
  number: 1,
  type: 'pr',
  state: 'open',
  title: 'test',
  url: '',
  labels: [],
  author: 'author',
  updatedAt: '',
  assignees: [],
  reviewRequests: []
}

function fixture() {
  const store = createTestStore()
  const cacheKey = workItemsCacheKey(item.repoId, 20, '')
  store.setState({ workItemsCache: { [cacheKey]: { data: [item], fetchedAt: 1 } } })
  return {
    patchWorkItem: store.getState().patchWorkItem,
    cached: () => store.getState().workItemsCache[cacheKey].data![0]
  }
}

afterEach(() => resetTaskPageGitHubMutationRegistryForTests())

describe('confirmed server lists with pending operations', () => {
  it('reapplies pending assignees after a scalar confirmation writes server lists', () => {
    const f = fixture()
    beginTaskPageGitHubWorkItemMutation({
      item,
      intent: { type: 'toggleAssignee', user: bob },
      patchWorkItem: f.patchWorkItem
    })
    const close = beginTaskPageGitHubWorkItemMutation({
      item,
      intent: { type: 'setState', state: 'closed' },
      patchWorkItem: f.patchWorkItem
    })
    confirmTaskPageGitHubWorkItemMutation(close.key, close.generation, {
      item,
      serverEntity: { state: 'closed', assignees: [], reviewRequests: [carol] },
      patchWorkItem: f.patchWorkItem
    })
    expect(f.cached().assignees).toEqual([bob])
    expect(f.cached().reviewRequests).toEqual([carol])
    expect(f.cached().state).toBe('closed')
  })

  it('keeps an unrelated cached list when the last assignee operation confirms', () => {
    const f = fixture()
    const assign = beginTaskPageGitHubWorkItemMutation({
      item,
      intent: { type: 'toggleAssignee', user: bob },
      patchWorkItem: f.patchWorkItem
    })
    f.patchWorkItem(item.id, { reviewRequests: [carol] }, item.repoId)
    confirmTaskPageGitHubWorkItemMutation(assign.key, assign.generation, {
      item,
      patchWorkItem: f.patchWorkItem
    })
    expect(f.cached().assignees).toEqual([bob])
    expect(f.cached().reviewRequests).toEqual([carol])
  })
})
