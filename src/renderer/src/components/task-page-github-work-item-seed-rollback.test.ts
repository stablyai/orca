import { afterEach, describe, expect, it } from 'vitest'
import type { GitHubWorkItem } from '../../../shared/github/work-item-types'
import { getTaskSourceCacheScope } from '../../../shared/task-source-context'
import { githubSourceContext } from '@/store/slices/github-slice-test-harness'
import {
  beginTaskPageGitHubWorkItemMutation,
  rollbackTaskPageGitHubWorkItemMutation,
  confirmTaskPageGitHubWorkItemMutation,
  getRegistryMergedTaskPageGitHubWorkItem
} from './task-page-github-work-item-mutations'
import {
  clearTaskPageGitHubConfirmedAuthority,
  getConfirmedListSnapshot,
  resetTaskPageGitHubMutationRegistryForTests,
  setTaskPageGitHubMutationQueryKey
} from './task-page-github-work-item-mutation-registry'

const alice = { login: 'alice', name: null, avatarUrl: '' }
const bob = { login: 'bob', name: null, avatarUrl: '' }
const base: GitHubWorkItem = {
  id: 'issue:1',
  repoId: 'repo-1',
  number: 1,
  type: 'issue',
  title: 'test',
  state: 'open',
  url: '',
  labels: [],
  updatedAt: '',
  author: 'author',
  assignees: [],
  reviewRequests: []
}
const patchWorkItem = () => {}
const sourceContext = githubSourceContext('runtime:env-1', base.repoId)
const sourceScope = getTaskSourceCacheScope(sourceContext)

function begin(user = alice, remote = false) {
  return beginTaskPageGitHubWorkItemMutation({
    item: base,
    intent: { type: 'toggleAssignee', user },
    patchWorkItem,
    sourceContext: remote ? sourceContext : null
  })
}
function reject(mutation: ReturnType<typeof begin>) {
  return rollbackTaskPageGitHubWorkItemMutation({
    ...mutation,
    item: base,
    patchWorkItem,
    sourceContext: mutation.key.sourceScope === sourceScope ? sourceContext : null
  })
}

afterEach(() => resetTaskPageGitHubMutationRegistryForTests())

describe('failed list baseline release', () => {
  it('isolates cleanup by source and family while another baseline is pending', () => {
    const local = begin()
    const remote = begin(alice, true)
    const review = beginTaskPageGitHubWorkItemMutation({
      item: base,
      intent: { type: 'addReviewers', logins: ['bob'], candidates: [bob] },
      patchWorkItem
    })
    reject(local)
    expect(getConfirmedListSnapshot(null, base.repoId, base.id, 'assignees')).toBeUndefined()
    expect(getRegistryMergedTaskPageGitHubWorkItem(base, sourceScope).assignees).toEqual([alice])
    expect(getRegistryMergedTaskPageGitHubWorkItem(base, null).reviewRequests).toEqual([bob])
    reject(remote)
    reject(review)
    expect(getConfirmedListSnapshot(sourceScope, base.repoId, base.id, 'assignees')).toBeUndefined()
    expect(getConfirmedListSnapshot(null, base.repoId, base.id, 'reviewRequests')).toBeUndefined()
  })

  it('retains a seed until its last pending sibling fails', () => {
    const a = begin()
    const b = begin(bob)
    reject(a)
    expect(getConfirmedListSnapshot(null, base.repoId, base.id, 'assignees')).toEqual([])
    expect(getRegistryMergedTaskPageGitHubWorkItem(base, null).assignees).toEqual([bob])
    reject(b)
    expect(getConfirmedListSnapshot(null, base.repoId, base.id, 'assignees')).toBeUndefined()
    expect(
      getRegistryMergedTaskPageGitHubWorkItem({ ...base, assignees: [alice] }, null).assignees
    ).toEqual([alice])
  })

  it('preserves a confirmed empty list when a later addition fails', () => {
    const a = begin()
    confirmTaskPageGitHubWorkItemMutation(a.key, a.generation, { item: base, patchWorkItem })
    const remove = begin()
    confirmTaskPageGitHubWorkItemMutation(remove.key, remove.generation, {
      item: base,
      patchWorkItem
    })
    reject(begin(bob))
    expect(getConfirmedListSnapshot(null, base.repoId, base.id, 'assignees')).toEqual([])
    expect(
      getRegistryMergedTaskPageGitHubWorkItem({ ...base, assignees: [alice] }, null).assignees
    ).toEqual([])
  })

  it.each(['query', 'refresh', 'reset'] as const)(
    'clears provenance on %s without leaking into a new failed edit',
    (action) => {
      setTaskPageGitHubMutationQueryKey('q')
      const a = begin()
      confirmTaskPageGitHubWorkItemMutation(a.key, a.generation, { item: base, patchWorkItem })
      if (action === 'query') {
        setTaskPageGitHubMutationQueryKey('next')
      }
      if (action === 'refresh') {
        clearTaskPageGitHubConfirmedAuthority()
      }
      if (action === 'reset') {
        resetTaskPageGitHubMutationRegistryForTests()
      }
      reject(begin(bob))
      expect(getConfirmedListSnapshot(null, base.repoId, base.id, 'assignees')).toBeUndefined()
      expect(
        getRegistryMergedTaskPageGitHubWorkItem({ ...base, assignees: [alice] }, null).assignees
      ).toEqual([alice])
    }
  )
})
