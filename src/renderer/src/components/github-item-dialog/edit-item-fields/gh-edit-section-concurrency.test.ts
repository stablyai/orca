// @vitest-environment happy-dom
import { renderHook, act, cleanup } from '@testing-library/react'
import { useState } from 'react'
import { getTaskSourceCacheScope } from '../../../../../shared/task-source-context'
import { useGHEditAssigneesAuthority } from './gh-edit-section-assignee-mutation'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GitHubWorkItem } from '../../../../../shared/github/work-item-types'
import type { ParsedTaskQuery } from '../../../../../shared/task-query'
import { createTestStore, githubSourceContext } from '@/store/slices/github-slice-test-harness'
import { workItemsCacheKey } from '@/store/github/cache-identity'
import {
  getConfirmedListSnapshot,
  resetTaskPageGitHubMutationRegistryForTests,
  setTaskPageGitHubMutationQueryKey,
  setConfirmedListSnapshot,
  getTaskPageGitHubMutationQueryKey
} from '@/components/task-page-github-work-item-mutation-registry'
import {
  beginTaskPageGitHubWorkItemMutation,
  confirmTaskPageGitHubWorkItemMutation,
  rollbackTaskPageGitHubWorkItemMutation,
  materializeTaskPageItemList,
  adoptQuietSearchFieldsForItem
} from '@/components/task-page-github-work-item-mutations'
import { runIssueUpdate } from '@/components/github/github-work-item-edit-mutations'
import { runGHEditAssigneeToggle, type GHEditMutationRun } from './gh-edit-section-mutations'

vi.mock('@/components/github/github-work-item-edit-mutations', () => ({ runIssueUpdate: vi.fn() }))

const alice = { login: 'alice', name: null, avatarUrl: '' }
const bob = { login: 'bob', name: null, avatarUrl: '' }
const query: ParsedTaskQuery = {
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
const base: GitHubWorkItem = {
  id: 'issue:1',
  type: 'issue',
  number: 1,
  title: 'test',
  state: 'open',
  url: 'https://github.com/o/r/issues/1',
  labels: [],
  updatedAt: '2026-01-01T00:00:00Z',
  author: 'author',
  repoId: 'repo-1',
  assignees: []
}
type Hooks = {
  onOptimistic?: () => void
  onRevert?: () => void
  onSuccess?: () => Promise<void>
  mutate: () => Promise<unknown>
}

/** Capture only the mutation scheduler; cache, authority and row lifecycle are production code. */
function fixture(
  sourceContext: ReturnType<typeof githubSourceContext> | null = null,
  initialSnapshot?: (typeof alice)[]
) {
  const store = createTestStore()
  const scope = sourceContext ? getTaskSourceCacheScope(sourceContext) : null
  const cacheKey = workItemsCacheKey('repo-1', 20, '', scope ?? undefined)
  store.setState({ workItemsCache: { [cacheKey]: { data: [base], fetchedAt: 1 } } })
  setTaskPageGitHubMutationQueryKey('q')
  if (initialSnapshot) {
    setConfirmedListSnapshot(scope, base.repoId, base.id, 'assignees', initialSnapshot)
  }
  let runCount = 0
  let hooks: Hooks | undefined
  let local: string[] = []
  let projectRow: string[] = []
  const run: GHEditMutationRun = async (_key, options) => {
    runCount++
    hooks = {
      onOptimistic: options.onOptimistic,
      onRevert: options.onRevert,
      mutate: options.mutate,
      onSuccess: async () => {
        const result = await options.mutate()
        options.onSuccess?.(result)
      }
    }
  }
  const dialogArgs = {
    item: base,
    login: 'alice',
    localAssignees: [],
    knownAssignees: [alice, bob],
    assigneesItemKey: 'repo-1:issue:1',
    editedAssigneesItemKeyRef: { current: null },
    itemId: base.id,
    itemNumber: 1,
    itemRepoId: base.repoId,
    repoPath: '/repo',
    sourceContext,
    projectOrigin: undefined,
    run,
    setLocalAssignees: (value) => {
      local = value
    },
    patchWorkItem: store.getState().patchWorkItem,
    patchProjectRowIfNeeded: (patch) => {
      projectRow = patch.assignees ?? projectRow
    },
    onMutated: () => {}
  } satisfies Parameters<typeof runGHEditAssigneeToggle>[0]
  runGHEditAssigneeToggle(dialogArgs)
  if (!hooks) {
    throw new Error('no scheduled dialog mutation')
  }
  const scheduled = hooks
  const cached = () => store.getState().workItemsCache[cacheKey].data![0]
  const beginRow = () => {
    const item = cached()
    return {
      item,
      mutation: beginTaskPageGitHubWorkItemMutation({
        item,
        intent: { type: 'toggleAssignee', user: bob },
        sourceContext,
        query,
        queryKey: 'q',
        viewerLogin: 'me',
        patchWorkItem: store.getState().patchWorkItem
      })
    }
  }
  const confirmRow = (row: ReturnType<typeof beginRow>) =>
    confirmTaskPageGitHubWorkItemMutation(row.mutation.key, row.mutation.generation, {
      item: row.item,
      sourceContext,
      query,
      queryKey: 'q',
      viewerLogin: 'me',
      patchWorkItem: store.getState().patchWorkItem
    })
  const rejectRow = (row: ReturnType<typeof beginRow>) =>
    rollbackTaskPageGitHubWorkItemMutation({
      key: row.mutation.key,
      generation: row.mutation.generation,
      item: row.item,
      sourceContext,
      query,
      queryKey: 'q',
      viewerLogin: 'me',
      patchWorkItem: store.getState().patchWorkItem
    })
  const snapshotLogins = () =>
    getConfirmedListSnapshot(scope, base.repoId, base.id, 'assignees')?.map((user) => user.login)
  return {
    toggle: (login: string) => runGHEditAssigneeToggle({ ...dialogArgs, login }),
    runCount: () => runCount,
    sourceContext,
    snapshotLogins,
    scheduled,
    cached,
    patchWorkItem: store.getState().patchWorkItem,
    beginRow,
    confirmRow,
    rejectRow,
    local: () => local,
    projectRow: () => projectRow
  }
}

afterEach(() => {
  cleanup()
  resetTaskPageGitHubMutationRegistryForTests()
})

describe.each([
  ['local', null],
  ['remote', githubSourceContext('runtime:env-1', 'repo-1')]
] as const)('dialog and Tasks-row assignee concurrency (%s)', (_name, sourceContext) => {
  it('does not schedule a dialog IPC while the same login is pending in the row', () => {
    const f = fixture(sourceContext)
    f.beginRow()
    f.toggle('BOB')
    expect(f.runCount()).toBe(1)
    expect(getTaskPageGitHubMutationQueryKey()).toBe('q')
  })

  it('uses composed authority for IPC direction when dialog details are stale', async () => {
    const f = fixture(sourceContext, [alice])
    f.scheduled.onOptimistic?.()
    await f.scheduled.mutate()
    expect(runIssueUpdate).toHaveBeenLastCalledWith(
      expect.objectContaining({ updates: { removeAssignees: ['alice'] } })
    )
    expect(f.cached().assignees).toEqual([])
  })

  it('control: standalone rejected dialog addition rolls back every surface', () => {
    const f = fixture(sourceContext)
    f.scheduled.onOptimistic?.()
    f.scheduled.onRevert?.()
    expect(f.cached().assignees).toEqual([])
    expect(f.local()).toEqual([])
    expect(f.projectRow()).toEqual([])
    expect(f.snapshotLogins()).toBeUndefined()
  })

  it('control: reject dialog before starting row mutation leaves only successful bob', () => {
    const f = fixture(sourceContext)
    f.scheduled.onOptimistic?.()
    f.scheduled.onRevert?.()
    const row = f.beginRow()
    f.confirmRow(row)
    expect(f.snapshotLogins()).toEqual(['bob'])
    expect(f.cached().assignees?.map((user) => user.login)).toEqual(['bob'])
  })

  it('row confirms bob before dialog rejects alice: failed alice must disappear', () => {
    const f = fixture(sourceContext)
    f.scheduled.onOptimistic?.()
    const row = f.beginRow()
    f.confirmRow(row)
    f.scheduled.onRevert?.()
    expect.soft(f.snapshotLogins()).toEqual(['bob'])
    expect.soft(f.cached().assignees?.map((user) => user.login)).toEqual(['bob'])
    expect.soft(f.local()).toEqual(['bob'])
    expect.soft(f.projectRow()).toEqual(['bob'])
    const refetched = materializeTaskPageItemList({
      networkItems: [{ ...base, assignees: [bob] }],
      previousItems: [f.cached()],
      queryKey: 'q'
    })
    expect.soft(refetched[0].assignees?.map((user) => user.login)).toEqual(['bob'])
  })

  it('dialog rejects alice while bob pending: successful bob must remain in cache', () => {
    const f = fixture(sourceContext)
    f.scheduled.onOptimistic?.()
    const row = f.beginRow()
    f.scheduled.onRevert?.()
    expect(f.snapshotLogins()).toEqual([])
    expect(f.cached().assignees?.map((user) => user.login)).toEqual(['bob'])
    expect(f.local()).toEqual(['bob'])
    expect(f.projectRow()).toEqual(['bob'])
    f.confirmRow(row)
    expect.soft(f.snapshotLogins()).toEqual(['bob'])
    expect.soft(f.cached().assignees?.map((user) => user.login)).toEqual(['bob'])
  })
  it('both row and dialog reject: captured optimistic dialog item must not return', () => {
    const f = fixture(sourceContext)
    f.scheduled.onOptimistic?.()
    const row = f.beginRow()
    f.scheduled.onRevert?.()
    f.rejectRow(row)
    expect(f.snapshotLogins()).toBeUndefined()
    expect.soft(f.cached().assignees).toEqual([])
    // The dialog callback retains still-pending Bob; the mounted subscription tracks its later failure.
    expect(f.local()).toEqual(['bob'])
    expect(f.projectRow()).toEqual(['bob'])
  })
})

describe.each([
  ['local', null],
  ['remote', githubSourceContext('runtime:env-1', 'repo-1')]
] as const)('mounted assignee authority (%s)', (_name, sourceContext) => {
  it.each(['confirmed', 'rolled_back'] as const)(
    'tracks row %s after dialog success despite its edit guard',
    async (outcome) => {
      const f = fixture(sourceContext)
      const editedRef = { current: 'repo-1:issue:1' }
      const project: { assignees: string[] } = { assignees: [] }
      const patchProjectRowIfNeeded = (patch: { assignees?: string[] }) => {
        project.assignees = patch.assignees ?? project.assignees
      }
      const { result } = renderHook(() => {
        const [assignees, setLocalAssignees] = useState<string[]>([])
        useGHEditAssigneesAuthority({
          item: base,
          sourceContext,
          assigneesItemKey: 'repo-1:issue:1',
          editedAssigneesItemKeyRef: editedRef,
          setLocalAssignees,
          patchProjectRowIfNeeded
        })
        return assignees
      })
      act(() => f.scheduled.onOptimistic?.())
      let row: ReturnType<typeof f.beginRow> | undefined
      act(() => {
        row = f.beginRow()
      })
      await act(() => f.scheduled.onSuccess?.())
      expect(editedRef.current).toBe('repo-1:issue:1')
      expect(result.current).toEqual(['alice', 'bob'])
      act(() => {
        if (!row) {
          throw new Error('row was not started')
        }
        if (outcome === 'confirmed') {
          f.confirmRow(row)
        } else {
          f.rejectRow(row)
        }
      })
      const expected = outcome === 'confirmed' ? ['alice', 'bob'] : ['alice']
      expect(result.current).toEqual(expected)
      expect(project.assignees).toEqual(expected)
      expect(f.cached().assignees?.map((user) => user.login)).toEqual(expected)
    }
  )

  it('failed dialog addition releases authority for a later Bob search, with stale mounted props', () => {
    const f = fixture(sourceContext)
    const editedRef: { current: string | null } = { current: null }
    const project: { assignees: string[] } = { assignees: [] }
    const patchProjectRowIfNeeded = (patch: { assignees?: string[] }) => {
      project.assignees = patch.assignees ?? project.assignees
    }
    const { result, rerender } = renderHook(
      ({ item }) => {
        const [assignees, setLocalAssignees] = useState<string[]>([])
        useGHEditAssigneesAuthority({
          item,
          sourceContext,
          assigneesItemKey: 'repo-1:issue:1',
          editedAssigneesItemKeyRef: editedRef,
          setLocalAssignees,
          patchProjectRowIfNeeded
        })
        return assignees
      },
      { initialProps: { item: base } }
    )
    act(() => f.scheduled.onOptimistic?.())
    rerender({ item: f.cached() })
    expect(result.current).toEqual(['alice'])
    act(() => f.scheduled.onRevert?.())
    expect(result.current).toEqual([])
    expect(project.assignees).toEqual([])
    expect(f.cached().assignees).toEqual([])
    expect(f.snapshotLogins()).toBeUndefined()
    expect(editedRef.current).toBeNull()
    rerender({ item: { ...base, assignees: [alice] } })
    expect(result.current).toEqual([])
    expect(project.assignees).toEqual([])
    const serverItem = { ...base, assignees: [bob] }
    act(() => {
      adoptQuietSearchFieldsForItem({
        item: f.cached(),
        serverItem,
        sourceScope: sourceContext ? getTaskSourceCacheScope(sourceContext) : null,
        queryKey: 'q',
        fetchStartedAtGeneration: 0,
        sourceContext,
        patchWorkItem: f.patchWorkItem
      })
    })
    expect(f.cached().assignees).toEqual([bob])
    expect(
      materializeTaskPageItemList({
        networkItems: [serverItem],
        previousItems: [f.cached()],
        queryKey: 'q'
      })[0].assignees
    ).toEqual([bob])
  })

  it('removes both failed additions from mounted dialog and Project callbacks', () => {
    const f = fixture(sourceContext)
    const project: string[][] = []
    const editedRef: { current: string | null } = { current: null }
    const patchProjectRowIfNeeded = (patch: { assignees?: string[] }) => {
      project.push(patch.assignees ?? [])
    }
    const { result, unmount } = renderHook(() => {
      const [assignees, setLocalAssignees] = useState<string[]>([])
      useGHEditAssigneesAuthority({
        item: base,
        sourceContext,
        assigneesItemKey: 'repo-1:issue:1',
        editedAssigneesItemKeyRef: editedRef,
        setLocalAssignees,
        patchProjectRowIfNeeded
      })
      return assignees
    })
    act(() => f.scheduled.onOptimistic?.())
    let row: ReturnType<typeof f.beginRow> | undefined
    act(() => {
      row = f.beginRow()
    })
    act(() => f.scheduled.onRevert?.())
    expect(result.current).toEqual(['bob'])
    act(() => {
      if (row) {
        f.rejectRow(row)
      }
    })
    expect(result.current).toEqual([])
    expect(project.at(-1)).toEqual([])
    const updates = project.length
    unmount()
    f.beginRow()
    expect(project).toHaveLength(updates)
  })
})
