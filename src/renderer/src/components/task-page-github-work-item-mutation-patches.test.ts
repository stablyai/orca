import { describe, expect, it } from 'vitest'
import type { GitHubWorkItem } from '../../../shared/types'
import {
  applyTaskPageGitHubListOps,
  buildTaskPageGitHubWorkItemMutationPatch,
  loginSetOfUsers,
  loginSetsEqual
} from './task-page-github-work-item-mutation-patches'

function baseItem(overrides: Partial<GitHubWorkItem> = {}): GitHubWorkItem {
  return {
    id: 'issue:1',
    type: 'issue',
    number: 1,
    title: 't',
    state: 'open',
    url: 'https://github.com/o/r/issues/1',
    labels: [],
    updatedAt: '2026-01-01T00:00:00Z',
    author: 'alice',
    repoId: 'repo-1',
    assignees: [],
    reviewRequests: [],
    ...overrides
  }
}

describe('applyTaskPageGitHubListOps', () => {
  it('adds and removes logins', () => {
    const snapshot = [{ login: 'alice', name: null, avatarUrl: '' }]
    const afterAdd = applyTaskPageGitHubListOps(snapshot, [
      {
        family: 'assignees',
        kind: 'add',
        logins: ['bob'],
        users: [{ login: 'bob', name: 'Bob', avatarUrl: 'x' }]
      }
    ])
    expect(afterAdd.map((u) => u.login)).toEqual(['alice', 'bob'])
    const afterRemove = applyTaskPageGitHubListOps(afterAdd, [
      { family: 'assignees', kind: 'remove', logins: ['alice'] }
    ])
    expect(afterRemove.map((u) => u.login)).toEqual(['bob'])
  })

  it('does not mutate input snapshot arrays', () => {
    const snapshot = [{ login: 'alice', name: null, avatarUrl: '' }]
    const frozen = [...snapshot]
    applyTaskPageGitHubListOps(snapshot, [{ family: 'assignees', kind: 'add', logins: ['bob'] }])
    expect(snapshot).toEqual(frozen)
  })
})

describe('buildTaskPageGitHubWorkItemMutationPatch', () => {
  it('builds merge patch with state merged and autoMerge cleared', () => {
    const item = baseItem({
      type: 'pr',
      state: 'open',
      autoMergeEnabled: true
    })
    const patch = buildTaskPageGitHubWorkItemMutationPatch(item, { type: 'merge' })
    expect(patch.kind).toBe('whole')
    if (patch.kind !== 'whole') {
      return
    }
    expect(patch.next).toEqual({ state: 'merged', autoMergeEnabled: false })
    expect(patch.previous).toEqual({ state: 'open', autoMergeEnabled: true })
  })

  it('builds autoMerge patch', () => {
    const patch = buildTaskPageGitHubWorkItemMutationPatch(baseItem({ type: 'pr' }), {
      type: 'setAutoMerge',
      enabled: true
    })
    expect(patch.next).toEqual({ autoMergeEnabled: true })
  })

  it('builds per-login assignee toggle', () => {
    const patch = buildTaskPageGitHubWorkItemMutationPatch(baseItem(), {
      type: 'toggleAssignee',
      user: { login: 'Alice', name: 'A', avatarUrl: '' }
    })
    expect(patch.kind).toBe('list')
    if (patch.kind !== 'list') {
      return
    }
    expect(patch.opKey).toBe('assignees:alice')
    expect(patch.listOp.kind).toBe('add')
    expect(patch.next.assignees?.map((u) => u.login.toLowerCase())).toEqual(['alice'])
  })

  it('builds multi-login reviewer batch opKey', () => {
    const patch = buildTaskPageGitHubWorkItemMutationPatch(baseItem({ type: 'pr' }), {
      type: 'addReviewers',
      logins: ['bob', 'carol'],
      candidates: [
        { login: 'bob', name: null, avatarUrl: '' },
        { login: 'carol', name: null, avatarUrl: '' }
      ]
    })
    expect(patch.kind).toBe('list')
    if (patch.kind !== 'list') {
      return
    }
    expect(patch.opKey).toBe('reviewRequests:batch:bob,carol')
    expect(patch.listOp.logins).toEqual(['bob', 'carol'])
  })
})

describe('loginSetsEqual', () => {
  it('compares case-insensitive login sets', () => {
    expect(
      loginSetsEqual(
        loginSetOfUsers([{ login: 'Alice', name: null, avatarUrl: '' }]),
        loginSetOfUsers([{ login: 'alice', name: null, avatarUrl: '' }])
      )
    ).toBe(true)
  })
})
