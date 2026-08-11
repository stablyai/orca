import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ParsedTaskQuery } from '../../../shared/task-query'
import type { GitHubWorkItem } from '../../../shared/types'
import {
  adoptQuietSearchFieldsForItem,
  applyPendingTaskPageGitHubMutationsToItems,
  beginTaskPageGitHubWorkItemMutation,
  confirmTaskPageGitHubWorkItemMutation,
  getRegistryMergedTaskPageGitHubWorkItem,
  materializeTaskPageItemList,
  overlayPendingOnTaskPagePages,
  rollbackTaskPageGitHubWorkItemMutation,
  settleQuietSearchRevalidate,
  reapplyPendingTaskPageGitHubMutationsToCache,
  clearTaskPageGitHubConfirmedAuthority,
  getTaskPageGitHubStickyHideForTests
} from './task-page-github-work-item-mutations'
import {
  getConfirmedListSnapshot,
  getLastConfirmedClientValue,
  getOrCreateQuietRevalidateState,
  getTaskPageGitHubSoftHiddenItemKeys,
  resetTaskPageGitHubMutationRegistryForTests,
  taskPageGitHubItemKey
} from './task-page-github-work-item-mutation-registry'

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

    // bob still pending
    void bob
  })

  it('multi-login batch confirm applies all logins; rollback of batch removes all', () => {
    const { patchWorkItem } = createPatchRecorder()
    const base = item({ type: 'pr', id: 'pr:1' })
    const began = beginTaskPageGitHubWorkItemMutation({
      item: base,
      intent: {
        type: 'addReviewers',
        logins: ['bob', 'carol'],
        candidates: [
          { login: 'bob', name: null, avatarUrl: '' },
          { login: 'carol', name: null, avatarUrl: '' }
        ]
      },
      query: query(),
      queryKey: 'q',
      viewerLogin: 'me',
      skipMeQualifiers: false,
      patchWorkItem
    })
    expect(
      getRegistryMergedTaskPageGitHubWorkItem(base, null).reviewRequests?.map((u) =>
        u.login.toLowerCase()
      )
    ).toEqual(['bob', 'carol'])

    confirmTaskPageGitHubWorkItemMutation(began.key, began.generation, {
      query: query(),
      queryKey: 'q',
      viewerLogin: 'me',
      item: base,
      patchWorkItem,
      scheduleQuiet: false
    })
    expect(
      getConfirmedListSnapshot(null, 'repo-1', 'pr:1', 'reviewRequests')?.map((u) =>
        u.login.toLowerCase()
      )
    ).toEqual(['bob', 'carol'])

    // Separate batch rollback path
    resetTaskPageGitHubMutationRegistryForTests()
    const began2 = beginTaskPageGitHubWorkItemMutation({
      item: base,
      intent: {
        type: 'addReviewers',
        logins: ['bob', 'carol'],
        candidates: [
          { login: 'bob', name: null, avatarUrl: '' },
          { login: 'carol', name: null, avatarUrl: '' }
        ]
      },
      query: query(),
      queryKey: 'q',
      viewerLogin: 'me',
      skipMeQualifiers: false,
      patchWorkItem
    })
    rollbackTaskPageGitHubWorkItemMutation({
      key: began2.key,
      generation: began2.generation,
      patchWorkItem,
      query: query(),
      queryKey: 'q',
      viewerLogin: 'me',
      item: base
    })
    expect(
      getRegistryMergedTaskPageGitHubWorkItem(base, null).reviewRequests?.map((u) => u.login) ?? []
    ).toEqual([])
  })

  it('matching server list releases authority; next begin keeps server metadata', () => {
    const { patches, patchWorkItem } = createPatchRecorder()
    // Seed confirmed snapshot [alice, carol] via sequential confirms.
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

  it('K21: thin search after confirmed add does not force-accept', () => {
    const { patchWorkItem } = createPatchRecorder()
    const base = item({
      assignees: [{ login: 'alice', name: null, avatarUrl: '' }]
    })
    // confirm alice already in snapshot path via begin+confirm bob on top of alice snapshot
    const addBob = beginTaskPageGitHubWorkItemMutation({
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
    confirmTaskPageGitHubWorkItemMutation(addBob.key, addBob.generation, {
      query: query(),
      queryKey: 'q',
      viewerLogin: 'me',
      item: base,
      patchWorkItem,
      scheduleQuiet: false
    })

    const quiet = getOrCreateQuietRevalidateState('q')
    quiet.fetchStartedAtGeneration = quiet.dirtyGeneration
    const thin = item({
      assignees: [{ login: 'alice', name: null, avatarUrl: '' }]
    })
    const result = adoptQuietSearchFieldsForItem({
      item: thin,
      serverItem: thin,
      sourceScope: null,
      queryKey: 'q',
      fetchStartedAtGeneration: quiet.fetchStartedAtGeneration,
      patchWorkItem
    })
    expect(result.needTrailing).toBe(true)
    expect(
      getConfirmedListSnapshot(null, 'repo-1', 'issue:1', 'assignees')?.map((u) =>
        u.login.toLowerCase()
      )
    ).toEqual(['alice', 'bob'])
  })

  it('K21: fat search after confirmed remove does not force-accept', () => {
    const { patchWorkItem } = createPatchRecorder()
    const base = item({
      assignees: [
        { login: 'alice', name: null, avatarUrl: '' },
        { login: 'bob', name: null, avatarUrl: '' }
      ]
    })
    const removeBob = beginTaskPageGitHubWorkItemMutation({
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
    confirmTaskPageGitHubWorkItemMutation(removeBob.key, removeBob.generation, {
      query: query(),
      queryKey: 'q',
      viewerLogin: 'me',
      item: base,
      patchWorkItem,
      scheduleQuiet: false
    })
    expect(
      getConfirmedListSnapshot(null, 'repo-1', 'issue:1', 'assignees')?.map((u) =>
        u.login.toLowerCase()
      )
    ).toEqual(['alice'])

    const quiet = getOrCreateQuietRevalidateState('q')
    quiet.fetchStartedAtGeneration = quiet.dirtyGeneration
    const fat = item({
      assignees: [
        { login: 'alice', name: null, avatarUrl: '' },
        { login: 'bob', name: null, avatarUrl: '' }
      ]
    })
    adoptQuietSearchFieldsForItem({
      item: fat,
      serverItem: fat,
      sourceScope: null,
      queryKey: 'q',
      fetchStartedAtGeneration: quiet.fetchStartedAtGeneration,
      patchWorkItem
    })
    expect(
      getConfirmedListSnapshot(null, 'repo-1', 'issue:1', 'assignees')?.map((u) =>
        u.login.toLowerCase()
      )
    ).toEqual(['alice'])
  })

  it('K21: lagging open after close confirm keeps closed + sticky', () => {
    const { patchWorkItem } = createPatchRecorder()
    const base = item({ state: 'open' })
    const began = beginTaskPageGitHubWorkItemMutation({
      item: base,
      intent: { type: 'setState', state: 'closed' },
      query: query({ state: 'open' }),
      queryKey: 'q',
      viewerLogin: 'me',
      skipMeQualifiers: false,
      patchWorkItem
    })
    confirmTaskPageGitHubWorkItemMutation(began.key, began.generation, {
      query: query({ state: 'open' }),
      queryKey: 'q',
      viewerLogin: 'me',
      item: base,
      patchWorkItem,
      scheduleQuiet: false
    })
    expect(getLastConfirmedClientValue(null, 'repo-1', 'issue:1', 'state')).toBe('closed')
    const itemKey = taskPageGitHubItemKey('repo-1', 'issue:1')
    expect(getTaskPageGitHubStickyHideForTests(itemKey)).toBeTruthy()
    expect(getTaskPageGitHubSoftHiddenItemKeys().has(itemKey)).toBe(true)

    const quiet = getOrCreateQuietRevalidateState('q')
    quiet.fetchStartedAtGeneration = quiet.dirtyGeneration
    // Simulate budget exceeded — still no force-accept
    quiet.lastConfirmAt = Date.now() - 200_000
    for (let i = 0; i < 6; i++) {
      adoptQuietSearchFieldsForItem({
        item: item({ state: 'open' }),
        serverItem: item({ state: 'open' }),
        sourceScope: null,
        queryKey: 'q',
        fetchStartedAtGeneration: quiet.fetchStartedAtGeneration,
        patchWorkItem
      })
    }
    expect(getLastConfirmedClientValue(null, 'repo-1', 'issue:1', 'state')).toBe('closed')
    expect(getTaskPageGitHubStickyHideForTests(itemKey)).toBeTruthy()
  })

  it('K22: confirm close then open under Open clears sticky', () => {
    const { patchWorkItem } = createPatchRecorder()
    const base = item({ state: 'open' })
    const close = beginTaskPageGitHubWorkItemMutation({
      item: base,
      intent: { type: 'setState', state: 'closed' },
      query: query({ state: 'open' }),
      queryKey: 'q',
      viewerLogin: 'me',
      skipMeQualifiers: false,
      patchWorkItem
    })
    confirmTaskPageGitHubWorkItemMutation(close.key, close.generation, {
      query: query({ state: 'open' }),
      queryKey: 'q',
      viewerLogin: 'me',
      item: base,
      patchWorkItem,
      scheduleQuiet: false
    })
    const itemKey = taskPageGitHubItemKey('repo-1', 'issue:1')
    expect(getTaskPageGitHubStickyHideForTests(itemKey)).toBeTruthy()

    const reopen = beginTaskPageGitHubWorkItemMutation({
      item: { ...base, state: 'closed' },
      intent: { type: 'setState', state: 'open' },
      query: query({ state: 'open' }),
      queryKey: 'q',
      viewerLogin: 'me',
      skipMeQualifiers: false,
      patchWorkItem
    })
    confirmTaskPageGitHubWorkItemMutation(reopen.key, reopen.generation, {
      query: query({ state: 'open' }),
      queryKey: 'q',
      viewerLogin: 'me',
      item: { ...base, state: 'closed' },
      patchWorkItem,
      scheduleQuiet: false
    })
    expect(getTaskPageGitHubStickyHideForTests(itemKey)).toBeUndefined()
    expect(getTaskPageGitHubSoftHiddenItemKeys().has(itemKey)).toBe(false)
  })

  it('whole-field supersede: stale rollback/confirm no-ops', () => {
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
    expect(
      confirmTaskPageGitHubWorkItemMutation(first.key, first.generation, {
        query: query(),
        queryKey: 'q',
        viewerLogin: 'me',
        item: base,
        scheduleQuiet: false
      })
    ).toBe('stale')
    expect(
      rollbackTaskPageGitHubWorkItemMutation({
        key: first.key,
        generation: first.generation,
        patchWorkItem,
        query: query(),
        queryKey: 'q',
        viewerLogin: 'me',
        item: base
      })
    ).toBe('stale')
    expect(
      confirmTaskPageGitHubWorkItemMutation(second.key, second.generation, {
        query: query(),
        queryKey: 'q',
        viewerLogin: 'me',
        item: base,
        scheduleQuiet: false
      })
    ).toBe('confirmed')
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

  it('materialize retains pending-omitted row; overlay preserves multi-page', () => {
    const { patchWorkItem } = createPatchRecorder()
    const base = item({ state: 'open' })
    beginTaskPageGitHubWorkItemMutation({
      item: base,
      intent: { type: 'setState', state: 'closed' },
      query: query({ state: 'open' }),
      queryKey: 'q',
      viewerLogin: 'me',
      skipMeQualifiers: false,
      patchWorkItem
    })
    const list = materializeTaskPageItemList({
      networkItems: [],
      previousItems: [base],
      queryKey: 'q'
    })
    expect(list).toHaveLength(1)
    expect(list[0].state).toBe('closed')

    const pages = overlayPendingOnTaskPagePages([
      [item({ id: 'issue:1', state: 'open' })],
      [item({ id: 'issue:2', repoId: 'repo-1', state: 'open' })]
    ])
    expect(pages).toHaveLength(2)
    expect(pages[0][0].state).toBe('closed')
    expect(pages[1]).toHaveLength(1)
  })

  it('multi-repo: pending on repo A and B both survive applyPending', () => {
    const { patchWorkItem } = createPatchRecorder()
    const a = item({ id: 'issue:1', repoId: 'repo-a', state: 'open' })
    const b = item({ id: 'issue:1', repoId: 'repo-b', state: 'open' })
    beginTaskPageGitHubWorkItemMutation({
      item: a,
      intent: { type: 'setState', state: 'closed' },
      query: query(),
      queryKey: 'q',
      viewerLogin: 'me',
      skipMeQualifiers: false,
      patchWorkItem
    })
    beginTaskPageGitHubWorkItemMutation({
      item: b,
      intent: { type: 'setState', state: 'closed' },
      query: query(),
      queryKey: 'q',
      viewerLogin: 'me',
      skipMeQualifiers: false,
      patchWorkItem
    })
    const applied = applyPendingTaskPageGitHubMutationsToItems([
      { ...a, state: 'open' },
      { ...b, state: 'open' }
    ])
    expect(applied.map((i) => i.state)).toEqual(['closed', 'closed'])
    expect(applied.map((i) => i.repoId)).toEqual(['repo-a', 'repo-b'])
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
    // Snapshot should still reflect confirmed bob (carol may be pending-cleared with snapshot)
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

describe('post-confirm authority with non-null sourceScope', () => {
  const sourceContext = {
    kind: 'task-source' as const,
    provider: 'github' as const,
    hostId: 'local' as const,
    projectId: 'proj',
    projectHostSetupId: 'setup',
    repoId: 'repo-1'
  }

  it('holds closed after confirm when overlay sees open network item', () => {
    const { patchWorkItem } = createPatchRecorder()
    const base = item({ state: 'open' })
    const began = beginTaskPageGitHubWorkItemMutation({
      item: base,
      intent: { type: 'setState', state: 'closed' },
      sourceContext,
      query: query(),
      queryKey: 'q',
      viewerLogin: 'me',
      skipMeQualifiers: false,
      patchWorkItem
    })
    expect(began.key.sourceScope).not.toBeNull()
    confirmTaskPageGitHubWorkItemMutation(began.key, began.generation, {
      query: query(),
      queryKey: 'q',
      viewerLogin: 'me',
      item: { ...base, state: 'closed' },
      patchWorkItem,
      sourceContext
    })
    const overlaid = applyPendingTaskPageGitHubMutationsToItems([item({ state: 'open' })])
    expect(overlaid[0].state).toBe('closed')
  })

  it('reapply after confirm holds closed when network returns open', () => {
    const store = new Map<string, GitHubWorkItem>()
    const base = item({ state: 'open' })
    store.set(base.id, base)
    const patchWorkItem = (id: string, patch: Partial<GitHubWorkItem>): void => {
      const current = store.get(id) ?? base
      store.set(id, { ...current, ...patch })
    }
    const began = beginTaskPageGitHubWorkItemMutation({
      item: base,
      intent: { type: 'setState', state: 'closed' },
      sourceContext,
      query: query(),
      queryKey: 'q',
      viewerLogin: 'me',
      skipMeQualifiers: false,
      patchWorkItem
    })
    confirmTaskPageGitHubWorkItemMutation(began.key, began.generation, {
      query: query(),
      queryKey: 'q',
      viewerLogin: 'me',
      item: { ...base, state: 'closed' },
      patchWorkItem,
      sourceContext
    })
    store.set(base.id, item({ state: 'open' }))
    reapplyPendingTaskPageGitHubMutationsToCache({
      items: [item({ state: 'open' })],
      patchWorkItem
    })
    expect(store.get(base.id)?.state).toBe('closed')
  })

  it('user-style clearConfirmedAuthority allows network open after hard refresh', () => {
    const { patchWorkItem } = createPatchRecorder()
    const base = item({ state: 'open' })
    const began = beginTaskPageGitHubWorkItemMutation({
      item: base,
      intent: { type: 'setState', state: 'closed' },
      sourceContext,
      query: query(),
      queryKey: 'q',
      viewerLogin: 'me',
      skipMeQualifiers: false,
      patchWorkItem
    })
    confirmTaskPageGitHubWorkItemMutation(began.key, began.generation, {
      query: query(),
      queryKey: 'q',
      viewerLogin: 'me',
      item: { ...base, state: 'closed' },
      patchWorkItem,
      sourceContext
    })
    clearTaskPageGitHubConfirmedAuthority()
    const overlaid = applyPendingTaskPageGitHubMutationsToItems([item({ state: 'open' })])
    expect(overlaid[0].state).toBe('open')
  })
})
