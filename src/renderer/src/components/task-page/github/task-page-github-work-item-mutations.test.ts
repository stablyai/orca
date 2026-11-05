import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ParsedTaskQuery } from '../../../../../shared/task-query'
import type { GitHubWorkItem } from '../../../../../shared/github/work-item-types'
import { adoptQuietSearchFieldsForItem } from './task-page-github-work-item-quiet-adopt'

import { beginTaskPageGitHubWorkItemMutation } from './task-page-github-work-item-mutations'
import {
  confirmTaskPageGitHubWorkItemMutation,
  rollbackTaskPageGitHubWorkItemMutation
} from './task-page-github-work-item-mutation-lifecycle'
import { getRegistryMergedTaskPageGitHubWorkItem } from './task-page-github-work-item-mutation-composition'
import { settleQuietSearchRevalidate } from './task-page-github-work-item-quiet-revalidate'
import {
  getConfirmedListSnapshot,
  resetTaskPageGitHubMutationRegistryForTests
} from './task-page-github-work-item-mutation-registry'
import { getLastConfirmedClientValue } from './task-page-github-confirmed-client-values'
import { getOrCreateQuietRevalidateState } from './task-page-github-work-item-quiet-state'

function query(overrides: Partial<ParsedTaskQuery> = {}): ParsedTaskQuery {
  return {
    scope: 'all',
    state: 'open',
    draft: false,
    assignee: null,
    author: null,
    reviewRequested: null,
    reviewedBy: null,
    labels: [],
    freeText: '',
    ...overrides
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
    assignees: [],
    reviewRequests: [],
    ...overrides
  }
}

function createPatchRecorder() {
  const patches: { id: string; patch: Partial<GitHubWorkItem>; repoId?: string }[] = []
  const patchWorkItem = (id: string, patch: Partial<GitHubWorkItem>, repoId?: string): void => {
    patches.push({ id, patch, repoId })
  }
  return { patches, patchWorkItem }
}

beforeEach(() => {
  resetTaskPageGitHubMutationRegistryForTests()
})

afterEach(() => {
  resetTaskPageGitHubMutationRegistryForTests()
})

describe('TaskPage GitHub work item mutations', () => {
  it('alice confirm while bob pending → composed [alice, bob]', () => {
    const { patchWorkItem } = createPatchRecorder()
    const base = item()
    const alice = beginTaskPageGitHubWorkItemMutation({
      item: base,
      intent: {
        type: 'toggleAssignee',
        user: { login: 'alice', name: null, avatarUrl: '' }
      },
      query: query(),
      queryKey: 'q',
      viewerLogin: 'me',
      skipMeQualifiers: false,
      patchWorkItem
    })
    const bob = beginTaskPageGitHubWorkItemMutation({
      item: base,
      intent: {
        type: 'toggleAssignee',
        user: { login: 'bob', name: null, avatarUrl: '' }
      },
      query: query(),
      queryKey: 'q',
      viewerLogin: 'me',
      skipMeQualifiers: false,
      patchWorkItem
    })

    confirmTaskPageGitHubWorkItemMutation(alice.key, alice.generation, {
      query: query(),
      queryKey: 'q',
      viewerLogin: 'me',
      item: base,
      patchWorkItem,
      scheduleQuiet: false
    })

    const merged = getRegistryMergedTaskPageGitHubWorkItem(base, null)
    expect(merged.assignees?.map((u) => u.login.toLowerCase()).sort()).toEqual(['alice', 'bob'])
    expect(
      getConfirmedListSnapshot(null, 'repo-1', 'issue:1', 'assignees')?.map((u) =>
        u.login.toLowerCase()
      )
    ).toEqual(['alice'])

    void bob
  })

  it('matching server list releases authority; next begin keeps server metadata', () => {
    const { patches, patchWorkItem } = createPatchRecorder()
    const empty = item({ assignees: [] })
    const addAlice = beginTaskPageGitHubWorkItemMutation({
      item: empty,
      intent: {
        type: 'toggleAssignee',
        user: { login: 'alice', name: null, avatarUrl: '' }
      },
      query: query(),
      queryKey: 'q',
      viewerLogin: 'me',
      skipMeQualifiers: false,
      patchWorkItem
    })
    confirmTaskPageGitHubWorkItemMutation(addAlice.key, addAlice.generation, {
      query: query(),
      queryKey: 'q',
      viewerLogin: 'me',
      item: empty,
      patchWorkItem,
      scheduleQuiet: false
    })
    const withAlice = item({
      assignees: [{ login: 'alice', name: null, avatarUrl: '' }]
    })
    const addCarol = beginTaskPageGitHubWorkItemMutation({
      item: withAlice,
      intent: {
        type: 'toggleAssignee',
        user: { login: 'carol', name: null, avatarUrl: '' }
      },
      query: query(),
      queryKey: 'q',
      viewerLogin: 'me',
      skipMeQualifiers: false,
      patchWorkItem
    })
    confirmTaskPageGitHubWorkItemMutation(addCarol.key, addCarol.generation, {
      query: query(),
      queryKey: 'q',
      viewerLogin: 'me',
      item: withAlice,
      patchWorkItem,
      scheduleQuiet: false
    })

    const server = item({
      assignees: [
        { login: 'alice', name: 'Alice', avatarUrl: 'a2' },
        { login: 'carol', name: 'Carol', avatarUrl: 'c2' }
      ]
    })
    const quiet = getOrCreateQuietRevalidateState('q')
    quiet.fetchStartedAtGeneration = quiet.dirtyGeneration
    adoptQuietSearchFieldsForItem({
      item: server,
      serverItem: server,
      sourceScope: null,
      queryKey: 'q',
      fetchStartedAtGeneration: quiet.fetchStartedAtGeneration,
      patchWorkItem
    })

    const snap = getConfirmedListSnapshot(null, 'repo-1', 'issue:1', 'assignees')
    expect(snap).toBeUndefined()
    expect(
      patches
        .findLast((entry) => entry.patch.assignees !== undefined)
        ?.patch.assignees?.find((u) => u.login === 'carol')?.avatarUrl
    ).toBe('c2')

    beginTaskPageGitHubWorkItemMutation({
      item: server,
      intent: {
        type: 'toggleAssignee',
        user: { login: 'bob', name: null, avatarUrl: '' }
      },
      query: query(),
      queryKey: 'q',
      viewerLogin: 'me',
      skipMeQualifiers: false,
      patchWorkItem
    })
    const merged = getRegistryMergedTaskPageGitHubWorkItem(server, null)
    expect(merged.assignees?.map((u) => u.login.toLowerCase()).sort()).toEqual([
      'alice',
      'bob',
      'carol'
    ])
  })

  it('per-login assignee: A fail after B begin leaves B only', () => {
    const { patchWorkItem } = createPatchRecorder()
    const base = item()
    const a = beginTaskPageGitHubWorkItemMutation({
      item: base,
      intent: {
        type: 'toggleAssignee',
        user: { login: 'alice', name: null, avatarUrl: '' }
      },
      query: query(),
      queryKey: 'q',
      viewerLogin: 'me',
      skipMeQualifiers: false,
      patchWorkItem
    })
    beginTaskPageGitHubWorkItemMutation({
      item: base,
      intent: {
        type: 'toggleAssignee',
        user: { login: 'bob', name: null, avatarUrl: '' }
      },
      query: query(),
      queryKey: 'q',
      viewerLogin: 'me',
      skipMeQualifiers: false,
      patchWorkItem
    })
    rollbackTaskPageGitHubWorkItemMutation({
      key: a.key,
      generation: a.generation,
      patchWorkItem,
      query: query(),
      queryKey: 'q',
      viewerLogin: 'me',
      item: base
    })
    const merged = getRegistryMergedTaskPageGitHubWorkItem(base, null)
    expect(merged.assignees?.map((u) => u.login.toLowerCase())).toEqual(['bob'])
  })

  it('dirty-bit: confirm during quiet R1 does not adopt thinner list', () => {
    const { patchWorkItem } = createPatchRecorder()
    const base = item({
      assignees: [{ login: 'alice', name: null, avatarUrl: '' }]
    })
    const bob = beginTaskPageGitHubWorkItemMutation({
      item: base,
      intent: {
        type: 'toggleAssignee',
        user: { login: 'bob', name: null, avatarUrl: '' }
      },
      query: query(),
      queryKey: 'q',
      viewerLogin: 'me',
      skipMeQualifiers: false,
      patchWorkItem
    })
    confirmTaskPageGitHubWorkItemMutation(bob.key, bob.generation, {
      query: query(),
      queryKey: 'q',
      viewerLogin: 'me',
      item: base,
      patchWorkItem,
      scheduleQuiet: false
    })
    // Quiet R1 started at generation before carol confirm
    const quiet = getOrCreateQuietRevalidateState('q')
    const g0 = quiet.dirtyGeneration
    quiet.fetchStartedAtGeneration = g0

    const carol = beginTaskPageGitHubWorkItemMutation({
      item: base,
      intent: {
        type: 'toggleAssignee',
        user: { login: 'carol', name: null, avatarUrl: '' }
      },
      query: query(),
      queryKey: 'q',
      viewerLogin: 'me',
      skipMeQualifiers: false,
      patchWorkItem
    })
    confirmTaskPageGitHubWorkItemMutation(carol.key, carol.generation, {
      query: query(),
      queryKey: 'q',
      viewerLogin: 'me',
      item: base,
      patchWorkItem,
      scheduleQuiet: false
    })
    expect(quiet.dirtyGeneration).toBeGreaterThan(g0)

    const thin = item({
      assignees: [{ login: 'alice', name: null, avatarUrl: '' }]
    })
    const settle = settleQuietSearchRevalidate({
      queryKey: 'q',
      networkItems: [thin],
      fetchStartedAtGeneration: g0,
      patchWorkItem
    })
    expect(settle.needTrailing).toBe(true)
    const snap = getConfirmedListSnapshot(null, 'repo-1', 'issue:1', 'assignees')
    expect(snap?.map((u) => u.login.toLowerCase()).sort()).toEqual(['alice', 'bob', 'carol'])
  })

  it('stale confirm does not clobber lastConfirmed', () => {
    vi.useFakeTimers()
    const { patchWorkItem } = createPatchRecorder()
    const base = item()
    const first = beginTaskPageGitHubWorkItemMutation({
      item: base,
      intent: { type: 'setState', state: 'closed' },
      query: query(),
      queryKey: 'q',
      viewerLogin: 'me',
      skipMeQualifiers: false,
      patchWorkItem
    })
    const second = beginTaskPageGitHubWorkItemMutation({
      item: base,
      intent: { type: 'setState', state: 'open' },
      query: query(),
      queryKey: 'q',
      viewerLogin: 'me',
      skipMeQualifiers: false,
      patchWorkItem
    })
    confirmTaskPageGitHubWorkItemMutation(second.key, second.generation, {
      query: query(),
      queryKey: 'q',
      viewerLogin: 'me',
      item: base,
      scheduleQuiet: false
    })
    confirmTaskPageGitHubWorkItemMutation(first.key, first.generation, {
      query: query(),
      queryKey: 'q',
      viewerLogin: 'me',
      item: base,
      scheduleQuiet: false
    })
    expect(getLastConfirmedClientValue(null, 'repo-1', 'issue:1', 'state')).toBe('open')
    vi.useRealTimers()
  })
})
