import { captureGitHubTaskObservation, observeGitHubWorkItem } from '@/lib/github-task-observation'
import { repo as registeredRepo } from '@/lib/github-task-refresh-data.test-fixture'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ParsedTaskQuery } from '../../../../../shared/task-query'
import type { GitHubWorkItem } from '../../../../../shared/github/work-item-types'

import {
  applyPendingTaskPageGitHubMutationsToItems,
  reapplyPendingTaskPageGitHubMutationsToCache
} from './task-page-github-work-item-mutation-pages'
import { beginTaskPageGitHubWorkItemMutation } from './task-page-github-work-item-mutations'
import { confirmTaskPageGitHubWorkItemMutation } from './task-page-github-work-item-mutation-lifecycle'

import {
  clearTaskPageGitHubConfirmedAuthority,
  resetTaskPageGitHubMutationRegistryForTests
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

describe('post-confirm authority with non-null sourceScope', () => {
  const sourceContext = {
    kind: 'task-source' as const,
    provider: 'github' as const,
    hostId: 'local' as const,
    projectId: 'proj',
    projectHostSetupId: 'setup',
    repoId: 'repo-1'
  }

  const observation = captureGitHubTaskObservation(
    { ...registeredRepo, id: 'repo-1' },
    sourceContext
  )

  it('holds closed after confirm when overlay sees open network item', () => {
    const { patchWorkItem } = createPatchRecorder()
    const base = item({ state: 'open' })
    const began = beginTaskPageGitHubWorkItemMutation({
      item: base,
      intent: { type: 'setState', state: 'closed' },
      sourceContext,
      observation,
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
    const overlaid = applyPendingTaskPageGitHubMutationsToItems([
      observeGitHubWorkItem(item({ state: 'open' }), observation)
    ])
    expect(overlaid[0].state).toBe('closed')
  })

  it('reapply after confirm holds closed when network returns open', () => {
    const store = new Map<string, GitHubWorkItem>()
    const base = item({ state: 'open' })
    store.set(base.id, base)
    const patchWorkItem: Parameters<
      typeof beginTaskPageGitHubWorkItemMutation
    >[0]['patchWorkItem'] = (id, patch): void => {
      const current = store.get(id) ?? base
      store.set(id, { ...current, ...patch })
    }
    const began = beginTaskPageGitHubWorkItemMutation({
      item: base,
      intent: { type: 'setState', state: 'closed' },
      sourceContext,
      observation,
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
      items: [observeGitHubWorkItem(item({ state: 'open' }), observation)],
      patchWorkItems: (patches) => {
        for (const { itemId, patch, repoId, options } of patches) {
          patchWorkItem(itemId, patch, repoId, options)
        }
      }
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
      observation,
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
    const overlaid = applyPendingTaskPageGitHubMutationsToItems([
      observeGitHubWorkItem(item({ state: 'open' }), observation)
    ])
    expect(overlaid[0].state).toBe('open')
  })
})
