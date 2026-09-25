import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  getConfirmedListSnapshot,
  resetTaskPageGitHubMutationRegistryForTests,
  setConfirmedListSnapshot,
  setTaskPageGitHubMutationQueryKey
} from '@/components/task-page-github-work-item-mutation-registry'
import {
  runGHEditAssigneeToggle,
  type GHEditMutationRun,
  type GHEditProjectRowPatch
} from './gh-edit-section-mutations'

vi.mock('@/components/github/github-work-item-edit-mutations', () => ({
  runIssueUpdate: vi.fn(async () => undefined)
}))

const me = { login: 'me', name: 'Me', avatarUrl: 'https://avatars/me' }
const other = { login: 'other', name: null, avatarUrl: '' }

type RunOptions = {
  mutate: () => Promise<unknown>
  onOptimistic: () => void
  onRevert: () => void
  onSuccess: () => void
  onError: (err: string) => void
}

/** Why: the dialog toggle only needs the lifecycle hooks, so capture them instead of running the request. */
function captureToggle(): {
  options: RunOptions
  localAssignees: string[][]
  rowPatches: GHEditProjectRowPatch[]
  cachePatches: string[][]
  editedRef: { current: string | null }
} {
  let captured: RunOptions | null = null
  const run = ((_key: string, options: RunOptions) => {
    captured = options
    return Promise.resolve()
  }) as unknown as GHEditMutationRun
  const localAssignees: string[][] = []
  const rowPatches: GHEditProjectRowPatch[] = []
  const cachePatches: string[][] = []
  const editedRef: { current: string | null } = { current: null }

  runGHEditAssigneeToggle({
    login: 'me',
    localAssignees: [],
    knownAssignees: [me, other],
    assigneesItemKey: 'repo-1:issue:1',
    editedAssigneesItemKeyRef: editedRef,
    itemId: 'issue:1',
    itemNumber: 1,
    itemRepoId: 'repo-1',
    repoPath: '/repo',
    sourceContext: null,
    projectOrigin: undefined,
    run,
    setLocalAssignees: (value) => localAssignees.push(value),
    patchWorkItem: (_id, patch) => cachePatches.push(patch.assignees.map((user) => user.login)),
    patchProjectRowIfNeeded: (patch) => rowPatches.push(patch),
    onMutated: () => {}
  })

  if (captured === null) {
    throw new Error('toggle did not schedule a mutation')
  }
  return { options: captured, localAssignees, rowPatches, cachePatches, editedRef }
}

afterEach(() => resetTaskPageGitHubMutationRegistryForTests())

describe('runGHEditAssigneeToggle rollback', () => {
  it('rolls every surface back when the toggle still owns the assignee authority', () => {
    setTaskPageGitHubMutationQueryKey('q')
    const toggle = captureToggle()

    toggle.options.onOptimistic()
    toggle.options.onRevert()

    expect(toggle.localAssignees).toEqual([['me'], []])
    expect(toggle.rowPatches).toEqual([{ assignees: ['me'] }, { assignees: [] }])
    expect(toggle.cachePatches).toEqual([['me'], []])
    expect(toggle.editedRef.current).toBeNull()
    expect(getConfirmedListSnapshot(null, 'repo-1', 'issue:1', 'assignees')).toBeUndefined()
  })

  it('leaves local assignees and the Project row to the new owner when authority was taken over', () => {
    // Why: a task-page mutation or quiet adopt can replace the assignees snapshot while the
    // request is in flight; reverting only the surfaces outside `authority.revert()` would
    // leave the dialog and the Project row on the old value while workItemsCache keeps the new one.
    setTaskPageGitHubMutationQueryKey('q')
    const toggle = captureToggle()

    toggle.options.onOptimistic()
    setConfirmedListSnapshot(null, 'repo-1', 'issue:1', 'assignees', [me, other])
    toggle.options.onRevert()

    expect(toggle.localAssignees).toEqual([['me']])
    expect(toggle.rowPatches).toEqual([{ assignees: ['me'] }])
    expect(toggle.cachePatches).toEqual([['me']])
    expect(toggle.editedRef.current).toBeNull()
    expect(getConfirmedListSnapshot(null, 'repo-1', 'issue:1', 'assignees')).toEqual([me, other])
  })
})
