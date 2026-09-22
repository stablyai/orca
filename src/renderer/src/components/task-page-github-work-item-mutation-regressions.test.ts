import { afterEach, describe, expect, it } from 'vitest'
import type { ParsedTaskQuery } from '../../../shared/task-query'
import type { GitHubWorkItem } from '../../../shared/github/work-item-types'
import {
  adoptQuietSearchFieldsForItem,
  advanceTaskPageQuietRevalidateScope,
  applyPendingTaskPageGitHubMutationsToItems,
  beginTaskPageGitHubWorkItemMutation,
  canStartTaskPageGitHubWorkItemMutation,
  clearTaskPageGitHubAuthorityAbsentFromLoadedItems,
  clearTaskPageGitHubAuthorityThroughGeneration,
  confirmTaskPageGitHubWorkItemMutation,
  getTaskPageQuietRevalidateBackoffAttempt,
  getTaskPageGitHubRevalidatableAuthorityItemKeys,
  isTaskPageQuietRevalidateRunCurrent,
  isTaskPageQuietRevalidateScopeCurrent,
  MAX_LAG_TRAILS,
  patchTaskPageGitHubWorkItemPages,
  reconcileTaskPagePagesAfterQuietRefresh,
  rebuildSoftHiddenFromItemsForTests
} from './task-page-github-work-item-mutations'
import {
  getLastConfirmedClientValue,
  getOrCreateQuietRevalidateState,
  getTaskPageGitHubSoftHiddenItemKeys,
  resetTaskPageGitHubMutationRegistryForTests,
  setTaskPageGitHubMutationQueryKey,
  subscribeTaskPageGitHubMutationRegistry,
  taskPageGitHubFamilyDirtyKey,
  taskPageGitHubItemKey
} from './task-page-github-work-item-mutation-registry'
import {
  beginTaskPageQuietRevalidateRun,
  finishTaskPageQuietRevalidateRun
} from './task-page-github-work-item-quiet-state'

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
  it('invalidates quiet responses after a query changes away and back', () => {
    const initial = { queryKey: 'q1', generation: 0 }
    const returned = advanceTaskPageQuietRevalidateScope(
      advanceTaskPageQuietRevalidateScope(initial, 'q2'),
      'q1'
    )
    expect(isTaskPageQuietRevalidateScopeCurrent(returned, 'q1', initial.generation)).toBe(false)
    expect(isTaskPageQuietRevalidateScopeCurrent(returned, 'q1', returned.generation)).toBe(true)
  })

  it('invalidates an older quiet response after a hard refresh dispatches', () => {
    expect(
      isTaskPageQuietRevalidateRunCurrent({ queryKey: 'q', generation: 0 }, 'q', 0, 0, 1)
    ).toBe(false)
  })

  it('lets a remounted TaskPage take over an orphaned quiet run', () => {
    const quiet = getOrCreateQuietRevalidateState('q')
    const oldOwner = {}
    const newOwner = {}
    const oldRun = beginTaskPageQuietRevalidateRun(quiet, oldOwner)
    const newRun = beginTaskPageQuietRevalidateRun(quiet, newOwner)
    if (oldRun === null || newRun === null) {
      throw new Error('Expected both quiet owners to start a run.')
    }
    expect(finishTaskPageQuietRevalidateRun(quiet, oldOwner, oldRun)).toBe(false)
    expect(quiet.inFlight).toBe(true)
    expect(finishTaskPageQuietRevalidateRun(quiet, newOwner, newRun)).toBe(true)
    expect(quiet.inFlight).toBe(false)
  })

  it('does not let an exhausted lag key block a newer item retry', () => {
    expect(getTaskPageQuietRevalidateBackoffAttempt([MAX_LAG_TRAILS, 1])).toBe(1)
  })

  it('resets exhausted family lag when a new confirmation arrives', () => {
    const base = item()
    const confirmState = (state: 'open' | 'closed'): void => {
      const began = beginTaskPageGitHubWorkItemMutation({
        item: base,
        intent: { type: 'setState', state },
        query: query(),
        queryKey: 'q',
        viewerLogin: 'me',
        patchWorkItem: () => {}
      })
      confirmTaskPageGitHubWorkItemMutation(began.key, began.generation, {
        query: query(),
        queryKey: 'q',
        viewerLogin: 'me',
        item: base
      })
    }
    confirmState('closed')
    const familyKey = taskPageGitHubFamilyDirtyKey(
      taskPageGitHubItemKey(base.repoId, base.id),
      'state'
    )
    getOrCreateQuietRevalidateState('q').lagSkipAttempts.set(familyKey, MAX_LAG_TRAILS)
    expect(getTaskPageGitHubRevalidatableAuthorityItemKeys('q')).not.toContain(
      taskPageGitHubItemKey(base.repoId, base.id)
    )
    confirmState('open')
    expect(getTaskPageGitHubRevalidatableAuthorityItemKeys('q')).toContain(
      taskPageGitHubItemKey(base.repoId, base.id)
    )
  })

  it('blocks a second same-key write while the first is unresolved', () => {
    const base = item()
    const input = { item: base, intent: { type: 'setState', state: 'closed' } as const }
    expect(canStartTaskPageGitHubWorkItemMutation(input)).toBe(true)
    beginTaskPageGitHubWorkItemMutation({
      ...input,
      query: query(),
      queryKey: 'q',
      viewerLogin: 'me',
      patchWorkItem: () => {}
    })
    expect(canStartTaskPageGitHubWorkItemMutation(input)).toBe(false)
  })

  it('blocks overlapping list and whole-field writes while allowing disjoint list writes', () => {
    const base = item({ reviewRequests: [] })
    beginTaskPageGitHubWorkItemMutation({
      item: base,
      intent: {
        type: 'addReviewers',
        logins: ['alice', 'bob'],
        candidates: []
      },
      query: query(),
      queryKey: 'q',
      viewerLogin: 'me',
      patchWorkItem: () => {}
    })
    expect(
      canStartTaskPageGitHubWorkItemMutation({
        item: base,
        intent: { type: 'removeReviewers', logins: ['alice'] }
      })
    ).toBe(false)
    expect(
      canStartTaskPageGitHubWorkItemMutation({
        item: base,
        intent: { type: 'removeReviewers', logins: ['carol'] }
      })
    ).toBe(true)

    const autoMerge = beginTaskPageGitHubWorkItemMutation({
      item: base,
      intent: { type: 'setAutoMerge', enabled: true },
      query: query(),
      queryKey: 'q',
      viewerLogin: 'me',
      patchWorkItem: () => {}
    })
    expect(autoMerge.opKey).toBe('autoMerge')
    expect(canStartTaskPageGitHubWorkItemMutation({ item: base, intent: { type: 'merge' } })).toBe(
      false
    )
  })

  it('does not notify subscribers when a soft-hide rebuild is unchanged', () => {
    const base = item()
    beginTaskPageGitHubWorkItemMutation({
      item: base,
      intent: { type: 'setState', state: 'closed' },
      query: query(),
      queryKey: 'q',
      viewerLogin: 'me',
      patchWorkItem: () => {}
    })
    let notifications = 0
    const unsubscribe = subscribeTaskPageGitHubMutationRegistry(() => {
      notifications += 1
    })
    rebuildSoftHiddenFromItemsForTests({
      query: query(),
      queryKey: 'q',
      viewerLogin: 'me',
      items: [base]
    })
    unsubscribe()
    expect(notifications).toBe(0)
  })

  it('preserves the visible page when an earlier authority page changes membership', () => {
    const pages = [[item({ id: 'issue:1' })], [item({ id: 'issue:2' })], [item({ id: 'issue:3' })]]
    const next = reconcileTaskPagePagesAfterQuietRefresh({
      pages,
      queryKey: 'q',
      authorityPage: 0,
      authorityItems: [],
      membershipChanged: true,
      visiblePage: 2,
      visibleItems: [item({ id: 'issue:4' })]
    })
    expect(next).toHaveLength(3)
    expect(next[1]).toBeNull()
    expect(next[2]?.[0].id).toBe('issue:4')
  })

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

  it('releases confirmed authority for rows no longer present on loaded pages', () => {
    const base = item({ autoMergeEnabled: false })
    const began = beginTaskPageGitHubWorkItemMutation({
      item: base,
      intent: { type: 'setAutoMerge', enabled: true },
      query: query(),
      queryKey: 'q',
      viewerLogin: 'me',
      patchWorkItem: () => {}
    })
    confirmTaskPageGitHubWorkItemMutation(began.key, began.generation, {
      query: query(),
      queryKey: 'q',
      viewerLogin: 'me',
      item: base
    })
    clearTaskPageGitHubAuthorityAbsentFromLoadedItems(new Set())
    expect(getTaskPageGitHubRevalidatableAuthorityItemKeys('q')).not.toContain(
      taskPageGitHubItemKey(base.repoId, base.id)
    )
  })

  it('preserves unavailable list metadata on untouched rows', () => {
    const [overlaid] = applyPendingTaskPageGitHubMutationsToItems([
      item({ assignees: undefined, reviewRequests: undefined })
    ])
    expect(overlaid.assignees).toBeUndefined()
    expect(overlaid.reviewRequests).toBeUndefined()
  })

  it('patches a later provider page without rebuilding untouched pages', () => {
    const firstPage = [item({ id: 'issue:1' })]
    const pages = patchTaskPageGitHubWorkItemPages(
      [firstPage, [item({ id: 'issue:2' })]],
      { id: 'issue:2', repoId: 'repo-1' },
      { state: 'closed' }
    )
    expect(pages[0]).toBe(firstPage)
    expect(pages[1]?.[0].state).toBe('closed')
  })

  it('does not claim authority over untouched search fields', () => {
    const patches: Partial<GitHubWorkItem>[] = []
    const patchWorkItem = (_id: string, patch: Partial<GitHubWorkItem>): void => {
      patches.push(patch)
    }
    const open = item({ state: 'open', assignees: undefined, reviewRequests: undefined })
    const closed = item({ state: 'closed', assignees: undefined, reviewRequests: undefined })
    for (const serverItem of [open, closed]) {
      adoptQuietSearchFieldsForItem({
        item: serverItem,
        serverItem,
        sourceScope: null,
        queryKey: 'q',
        fetchStartedAtGeneration: 0,
        patchWorkItem
      })
    }
    expect(getLastConfirmedClientValue(null, open.repoId, open.id, 'state')).toBeUndefined()
    expect(patches.findLast((patch) => patch.state !== undefined)?.state).toBe('closed')
    expect(patches.at(-1)?.assignees).toBeUndefined()
  })
})
