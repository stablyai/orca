import { afterEach, describe, expect, it } from 'vitest'
import type { GitHubWorkItem } from '../../../shared/github/work-item-types'
import { getTaskSourceCacheScope } from '../../../shared/task-source-context'
import { assertTaskPageGitHubDialogStateAuthority } from './task-page-github-dialog-state-authority'
import {
  adoptQuietSearchFieldsForItem,
  applyPendingTaskPageGitHubMutationsToItems,
  materializeTaskPageItemList,
  reapplyPendingTaskPageGitHubMutationsToCache
} from './task-page-github-work-item-mutations'
import {
  deleteLastConfirmedClientValue,
  getLastConfirmedClientValue,
  getOrCreateQuietRevalidateState,
  resetTaskPageGitHubMutationRegistryForTests,
  setLastConfirmedClientValue,
  setTaskPageGitHubMutationQueryKey,
  taskPageGitHubFamilyDirtyKey,
  taskPageGitHubItemKey
} from './task-page-github-work-item-mutation-registry'

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

const sourceContext = {
  kind: 'task-source' as const,
  provider: 'github' as const,
  hostId: 'local' as const,
  projectId: 'proj',
  projectHostSetupId: 'setup',
  repoId: 'repo-1'
}

afterEach(() => resetTaskPageGitHubMutationRegistryForTests())

describe('dialog state authority (STA-3343)', () => {
  it('without authority a stale search refetch reverts a cache-only patch (external edits adopt)', () => {
    // Why: documents the pre-fix dialog behavior — patchWorkItem alone gives the
    // row no registry protection, so the lagging search response wins.
    const materialized = materializeTaskPageItemList({
      networkItems: [item({ state: 'open' })],
      previousItems: [item({ state: 'closed' })],
      queryKey: 'q'
    })
    expect(materialized[0]?.state).toBe('open')
  })

  it('holds a dialog-confirmed close over a stale search refetch', () => {
    setTaskPageGitHubMutationQueryKey('q')
    assertTaskPageGitHubDialogStateAuthority({
      repoId: 'repo-1',
      itemId: 'issue:1',
      state: 'closed'
    })
    const materialized = materializeTaskPageItemList({
      networkItems: [item({ state: 'open' })],
      previousItems: [item({ state: 'closed' })],
      queryKey: 'q'
    })
    expect(materialized[0]?.state).toBe('closed')
  })

  it('holds the close through the cache re-apply path too', () => {
    setTaskPageGitHubMutationQueryKey('q')
    assertTaskPageGitHubDialogStateAuthority({
      repoId: 'repo-1',
      itemId: 'issue:1',
      state: 'closed'
    })
    const store = new Map<string, GitHubWorkItem>([['issue:1', item({ state: 'open' })]])
    reapplyPendingTaskPageGitHubMutationsToCache({
      items: [item({ state: 'open' })],
      patchWorkItem: (id, patch) => {
        store.set(id, { ...(store.get(id) ?? item()), ...patch })
      }
    })
    expect(store.get('issue:1')?.state).toBe('closed')
  })

  it('records authority under the mutation source scope so other scopes are untouched', () => {
    setTaskPageGitHubMutationQueryKey('q')
    assertTaskPageGitHubDialogStateAuthority({
      repoId: 'repo-1',
      itemId: 'issue:1',
      state: 'closed',
      sourceContext
    })
    const scope = getTaskSourceCacheScope(sourceContext)
    expect(getLastConfirmedClientValue(scope, 'repo-1', 'issue:1', 'state')).toBe('closed')
    expect(getLastConfirmedClientValue(null, 'repo-1', 'issue:1', 'state')).toBeUndefined()
    // Why: overlay resolves the remembered scope, so the list row still holds.
    const overlaid = applyPendingTaskPageGitHubMutationsToItems([item({ state: 'open' })])
    expect(overlaid[0]?.state).toBe('closed')
  })

  it('marks the state family dirty so quiet revalidation trails the stale row', () => {
    setTaskPageGitHubMutationQueryKey('q')
    const before = getOrCreateQuietRevalidateState('q').dirtyGeneration
    assertTaskPageGitHubDialogStateAuthority({
      repoId: 'repo-1',
      itemId: 'issue:1',
      state: 'closed'
    })
    const quiet = getOrCreateQuietRevalidateState('q')
    expect(quiet.dirtyGeneration).toBe(before + 1)
    expect(
      quiet.familyDirtyAt.get(
        taskPageGitHubFamilyDirtyKey(taskPageGitHubItemKey('repo-1', 'issue:1'), 'state')
      )
    ).toBe(quiet.dirtyGeneration)
  })

  it('releases authority once search reports the confirmed state, so later external edits win', () => {
    setTaskPageGitHubMutationQueryKey('q')
    assertTaskPageGitHubDialogStateAuthority({
      repoId: 'repo-1',
      itemId: 'issue:1',
      state: 'closed'
    })
    const patched: Partial<GitHubWorkItem>[] = []
    adoptQuietSearchFieldsForItem({
      item: item({ state: 'closed' }),
      serverItem: item({ state: 'closed' }),
      sourceScope: null,
      queryKey: 'q',
      fetchStartedAtGeneration: getOrCreateQuietRevalidateState('q').dirtyGeneration,
      patchWorkItem: (_id, patch) => patched.push(patch)
    })
    expect(getLastConfirmedClientValue(null, 'repo-1', 'issue:1', 'state')).toBeUndefined()
    const overlaid = applyPendingTaskPageGitHubMutationsToItems([item({ state: 'open' })])
    expect(overlaid[0]?.state).toBe('open')
  })

  it('revert drops fresh authority and restores a pre-existing value', () => {
    setTaskPageGitHubMutationQueryKey('q')
    const fresh = assertTaskPageGitHubDialogStateAuthority({
      repoId: 'repo-1',
      itemId: 'issue:1',
      state: 'closed'
    })
    expect(fresh.revert()).toBe(true)
    expect(getLastConfirmedClientValue(null, 'repo-1', 'issue:1', 'state')).toBeUndefined()

    setLastConfirmedClientValue(null, 'repo-1', 'issue:1', 'state', 'open')
    const layered = assertTaskPageGitHubDialogStateAuthority({
      repoId: 'repo-1',
      itemId: 'issue:1',
      state: 'closed'
    })
    expect(layered.revert()).toBe(true)
    expect(getLastConfirmedClientValue(null, 'repo-1', 'issue:1', 'state')).toBe('open')
  })

  it('does not roll back authority released by search or superseded by a newer state', () => {
    setTaskPageGitHubMutationQueryKey('q')
    const released = assertTaskPageGitHubDialogStateAuthority({
      repoId: 'repo-1',
      itemId: 'issue:1',
      state: 'closed'
    })
    deleteLastConfirmedClientValue(null, 'repo-1', 'issue:1', 'state')
    expect(released.revert()).toBe(false)
    expect(getLastConfirmedClientValue(null, 'repo-1', 'issue:1', 'state')).toBeUndefined()

    const superseded = assertTaskPageGitHubDialogStateAuthority({
      repoId: 'repo-1',
      itemId: 'issue:1',
      state: 'closed'
    })
    setLastConfirmedClientValue(null, 'repo-1', 'issue:1', 'state', 'merged')
    expect(superseded.revert()).toBe(false)
    expect(getLastConfirmedClientValue(null, 'repo-1', 'issue:1', 'state')).toBe('merged')
  })
})
