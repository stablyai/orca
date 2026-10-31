import { captureGitHubTaskObservation, observeGitHubWorkItem } from '@/lib/github-task-observation'
import { repo, source } from '@/lib/github-task-refresh-data.test-fixture'
import { createTaskPageGitHubMembershipProjection } from './task-page-github-work-item-mutation-composition'
import { afterEach, describe, expect, it } from 'vitest'
import type { ParsedTaskQuery } from '../../../../../shared/task-query'
import type { GitHubWorkItem } from '../../../../../shared/github/work-item-types'
import {
  adoptQuietSearchFieldsForItem,
  MAX_LAG_TRAILS
} from './task-page-github-work-item-quiet-adopt'
import {
  advanceTaskPageQuietRevalidateScope,
  getTaskPageQuietRevalidateBackoffAttempt,
  isTaskPageQuietRevalidateRunCurrent,
  isTaskPageQuietRevalidateScopeCurrent
} from './task-page-github-work-item-quiet-revalidate'
import {
  applyPendingTaskPageGitHubMutationsToItems,
  patchTaskPageGitHubWorkItemPages,
  reconcileTaskPagePagesAfterQuietRefresh
} from './task-page-github-work-item-mutation-pages'
import {
  beginTaskPageGitHubWorkItemMutation,
  canStartTaskPageGitHubWorkItemMutation
} from './task-page-github-work-item-mutations'
import {
  clearTaskPageGitHubAuthorityAbsentFromLoadedItems,
  clearTaskPageGitHubAuthorityThroughGeneration,
  getTaskPageGitHubRevalidatableAuthorityItemKeys
} from './task-page-github-work-item-authority-refresh'
import { confirmTaskPageGitHubWorkItemMutation } from './task-page-github-work-item-mutation-lifecycle'
import { getLastConfirmedClientValue } from './task-page-github-confirmed-client-values'
import {
  getOrCreateQuietRevalidateState,
  beginTaskPageQuietRevalidateRun,
  finishTaskPageQuietRevalidateRun
} from './task-page-github-work-item-quiet-state'
import {
  resetTaskPageGitHubMutationRegistryForTests,
  setTaskPageGitHubMutationQueryKey,
  subscribeTaskPageGitHubMutationRegistry
} from './task-page-github-work-item-mutation-registry'
import {
  taskPageGitHubFamilyDirtyKey,
  taskPageGitHubOwnedItemKey
} from './task-page-github-work-item-mutation-keys'

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
      taskPageGitHubOwnedItemKey(null, base.repoId, base.id),
      'state'
    )
    getOrCreateQuietRevalidateState('q').lagSkipAttempts.set(familyKey, MAX_LAG_TRAILS)
    expect(getTaskPageGitHubRevalidatableAuthorityItemKeys('q')).not.toContain(
      taskPageGitHubOwnedItemKey(null, base.repoId, base.id)
    )
    confirmState('open')
    expect(getTaskPageGitHubRevalidatableAuthorityItemKeys('q')).toContain(
      taskPageGitHubOwnedItemKey(null, base.repoId, base.id)
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

  it('derives membership without notifying registry subscribers', () => {
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
    expect(
      createTaskPageGitHubMembershipProjection({
        query: query(),
        queryKey: 'q',
        viewerLogin: 'me'
      })(base, null).hide
    ).toBe(true)
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

  it('does not mark a successor quiet query dirty from an old callback', () => {
    const base = item()
    const began = beginTaskPageGitHubWorkItemMutation({
      item: base,
      intent: { type: 'setState', state: 'closed' },
      query: query(),
      queryKey: 'old',
      viewerLogin: 'me',
      patchWorkItem: () => {}
    })
    setTaskPageGitHubMutationQueryKey('current')
    confirmTaskPageGitHubWorkItemMutation(began.key, began.generation, {
      item: base,
      query: query(),
      queryKey: 'old',
      viewerLogin: 'me'
    })
    expect(getOrCreateQuietRevalidateState('current').dirtyGeneration).toBe(0)
    expect(
      createTaskPageGitHubMembershipProjection({
        query: query(),
        queryKey: 'current',
        viewerLogin: 'me'
      })(base, null).hide
    ).toBe(true)
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
    expect(
      createTaskPageGitHubMembershipProjection({
        query: query(),
        queryKey: 'q',
        viewerLogin: 'me'
      })(base, null).hide
    ).toBe(false)
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
      taskPageGitHubOwnedItemKey(null, base.repoId, base.id)
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

it('uses the resolved observed PR owner for omitted and explicit pending family overlap through settlement', () => {
  const observation = captureGitHubTaskObservation(repo, source)!
  const other = { ...observation, key: `${observation.key}:other` }
  const base = observeGitHubWorkItem(
    item({ type: 'pr', id: 'pr:1', url: 'https://github.com/o/r/pull/1', reviewRequests: [] }),
    observation
  )
  const start = (
    intent: Parameters<typeof beginTaskPageGitHubWorkItemMutation>[0]['intent'],
    override?: typeof observation
  ) =>
    beginTaskPageGitHubWorkItemMutation({
      item: base,
      intent,
      observation: override,
      query: query(),
      queryKey: 'q',
      viewerLogin: 'me',
      patchWorkItem: () => {}
    })
  const reviewers = start({ type: 'addReviewers', logins: ['alice', 'bob'], candidates: [] })
  expect(
    canStartTaskPageGitHubWorkItemMutation({
      item: base,
      intent: { type: 'removeReviewers', logins: ['alice'] }
    })
  ).toBe(false)
  expect(
    canStartTaskPageGitHubWorkItemMutation({
      item: base,
      intent: { type: 'removeReviewers', logins: ['cora'] }
    })
  ).toBe(true)
  expect(
    canStartTaskPageGitHubWorkItemMutation({
      item: base,
      observation: other,
      intent: { type: 'removeReviewers', logins: ['alice'] }
    })
  ).toBe(true)
  confirmTaskPageGitHubWorkItemMutation(reviewers.key, reviewers.generation, {
    item: base,
    query: query(),
    queryKey: 'q',
    viewerLogin: 'me'
  })
  expect(
    canStartTaskPageGitHubWorkItemMutation({
      item: base,
      intent: { type: 'removeReviewers', logins: ['alice'] }
    })
  ).toBe(true)
  const automatic = start({ type: 'setAutoMerge', enabled: true }, other)
  expect(canStartTaskPageGitHubWorkItemMutation({ item: base, intent: { type: 'merge' } })).toBe(
    true
  )
  expect(
    canStartTaskPageGitHubWorkItemMutation({
      item: base,
      observation: other,
      intent: { type: 'merge' }
    })
  ).toBe(false)
  confirmTaskPageGitHubWorkItemMutation(automatic.key, automatic.generation, {
    item: base,
    query: query(),
    queryKey: 'q',
    viewerLogin: 'me'
  })
  const own = start({ type: 'setAutoMerge', enabled: true })
  expect(
    canStartTaskPageGitHubWorkItemMutation({
      item: base,
      intent: { type: 'setAutoMerge', enabled: true }
    })
  ).toBe(false)
  expect(canStartTaskPageGitHubWorkItemMutation({ item: base, intent: { type: 'merge' } })).toBe(
    false
  )
  confirmTaskPageGitHubWorkItemMutation(own.key, own.generation, {
    item: base,
    query: query(),
    queryKey: 'q',
    viewerLogin: 'me'
  })
  expect(canStartTaskPageGitHubWorkItemMutation({ item: base, intent: { type: 'merge' } })).toBe(
    true
  )
})
