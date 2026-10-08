// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useActionsRuns } from './use-actions-runs'
import { useActionsRepositories } from './use-actions-repositories'
import * as requests from '@/store/github/actions-requests'
import { useAppStore } from '@/store'
import { TEST_REPO } from '@/store/slices/store-test-helpers'
import { makeWorktree, makeFolderWorkspace } from '@/store/slices/worktrees-slice-test-fixtures'
import type { ActionsPage, ActionsRun } from '../../../../shared/github/actions-types'
import { actionsCandidateRepos } from './actions-repositories'
import { ActionsFilters } from '../task-page/github/actions/ActionsFilters'

const repository = { owner: 'acme', repo: 'widgets', host: 'github.com' }
const option = { repo: TEST_REPO, repository }
const page: ActionsPage<ActionsRun> = {
  repository,
  items: [],
  page: 1,
  perPage: 50,
  totalCount: 0,
  hasNextPage: false,
  limitReached: false
}
const initialState = useAppStore.getState()
afterEach(() => {
  cleanup()
  useAppStore.setState(initialState, true)
  vi.restoreAllMocks()
})
async function settle() {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}
describe('Actions panel generations and registered repositories', () => {
  it('discards late results from previous filters and resets pagination on refresh', async () => {
    let resolve: (value: ActionsPage<ActionsRun>) => void = () => {}
    const read = vi
      .spyOn(requests, 'fetchActionsRuns')
      .mockImplementationOnce(
        () =>
          new Promise((done) => {
            resolve = done
          })
      )
      .mockResolvedValue(page)
    vi.spyOn(requests, 'fetchActionsWorkflows').mockResolvedValue({ ...page, items: [] })
    const { result } = renderHook(() => useActionsRuns(option))
    await act(async () => result.current.setQuery({ branch: 'new-branch', page: 2 }))
    await settle()
    await act(async () => resolve({ ...page, totalCount: 999 }))
    expect(result.current.data?.totalCount).toBe(0)
    await act(async () => result.current.refresh())
    expect(read).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ branch: 'new-branch', page: 1, noCache: true })
    )
  })
  it('retries a failed workflow page without skipping it or erasing successful runs', async () => {
    const runs = vi.spyOn(requests, 'fetchActionsRuns').mockResolvedValue(page)
    const workflows = vi
      .spyOn(requests, 'fetchActionsWorkflows')
      .mockResolvedValueOnce({
        ...page,
        items: [{ id: 1, name: 'Build', path: null, state: 'active' }],
        hasNextPage: true
      })
      .mockRejectedValueOnce(new Error('page failed'))
      .mockResolvedValueOnce({
        ...page,
        page: 2,
        items: [{ id: 2, name: 'Deploy', path: null, state: 'active' }]
      })
    const { result } = renderHook(() => useActionsRuns(option))
    await settle()
    await act(async () => result.current.setQuery({ branch: 'release', page: 3 }))
    await act(async () => result.current.moreWorkflows())
    await settle()
    expect(result.current.workflows.error).toBe('page failed')
    expect(result.current.data).toEqual(page)
    render(<ActionsFilters model={result.current} option={option} />)
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Retry workflows' })))
    await settle()
    expect(workflows.mock.calls.map((call) => call[2].page)).toEqual([1, 2, 2])
    expect(result.current.workflows.items.map((workflow) => workflow.id)).toEqual([1, 2])
    expect(result.current.query).toEqual({ branch: 'release', page: 3 })
    expect(runs).toHaveBeenCalledTimes(2)
    expect(workflows.mock.calls.every((call) => !call[2].noCache)).toBe(true)
  })
  it('does not refetch discovery after unrelated worktree metadata changes', async () => {
    const repo = { ...TEST_REPO, id: 'stable-probe-repo' }
    const worktree = makeWorktree({ id: 'stable-worktree', repoId: repo.id })
    useAppStore.setState({ repos: [repo], worktreesByRepo: { [repo.id]: [worktree] } })
    const probe = vi.spyOn(requests, 'fetchActionsRepository').mockResolvedValue(repository)
    const { result } = renderHook(() => useActionsRepositories(worktree.id))
    await settle()
    expect(result.current.options).toHaveLength(1)
    await act(async () =>
      useAppStore.setState({
        worktreesByRepo: { [repo.id]: [{ ...worktree, lastActivityAt: 999 }] }
      })
    )
    await settle()
    expect(probe).toHaveBeenCalledTimes(1)
  })
  it('does not issue run reads until a verified GitHub repository is selected', async () => {
    const read = vi.spyOn(requests, 'fetchActionsRuns')
    const { result } = renderHook(() => useActionsRuns(undefined))
    await settle()
    expect(read).not.toHaveBeenCalled()
    expect(result.current.data).toBeNull()
    expect(result.current.loading).toBe(false)
  })
  it('preserves discovery errors separately from a non-GitHub repository', async () => {
    const repo = { ...TEST_REPO, id: 'failed-probe-repo' }
    const worktree = makeWorktree({ id: 'failed-worktree', repoId: repo.id })
    useAppStore.setState({ repos: [repo], worktreesByRepo: { [repo.id]: [worktree] } })
    vi.spyOn(requests, 'fetchActionsRepository').mockRejectedValue(
      new Error('SSH provider unavailable')
    )
    const { result } = renderHook(() => useActionsRepositories(worktree.id))
    await settle()
    expect(result.current.available).toBe(true)
    expect(result.current.error).toBe('SSH provider unavailable')
    expect(result.current.options).toEqual([])
  })
  it('hides proven non-GitHub discovery results', async () => {
    const repo = { ...TEST_REPO, id: 'non-github-repo' }
    const worktree = makeWorktree({ id: 'non-github-worktree', repoId: repo.id })
    useAppStore.setState({ repos: [repo], worktreesByRepo: { [repo.id]: [worktree] } })
    vi.spyOn(requests, 'fetchActionsRepository').mockResolvedValue(null)
    const { result } = renderHook(() => useActionsRepositories(worktree.id))
    await settle()
    expect(result.current.available).toBe(false)
    expect(result.current.error).toBeNull()
  })
  it('uses the Tasks project selection without requiring an active workspace', async () => {
    const selected = { ...TEST_REPO, id: 'tasks-selected', path: '/tasks-selected' }
    const other = { ...TEST_REPO, id: 'tasks-other', path: '/tasks-other' }
    const folder = { ...TEST_REPO, id: 'tasks-folder', kind: 'folder' as const }
    useAppStore.setState({ repos: [selected, other, folder], worktreesByRepo: {} })
    const probe = vi.spyOn(requests, 'fetchActionsRepository').mockResolvedValue(repository)
    const selection = new Set([selected.id, folder.id])
    const { result } = renderHook(() => useActionsRepositories(null, selection))
    await settle()
    expect(result.current.options.map((entry) => entry.repo.id)).toEqual([selected.id])
    expect(probe).toHaveBeenCalledTimes(1)
    expect(probe).toHaveBeenCalledWith(expect.anything(), {
      repoId: selected.id,
      repoPath: selected.path
    })
  })
  it('chooses only registered Git children in a folder workspace', () => {
    const folder = makeFolderWorkspace({ folderPath: '/repo1' })
    const child = { ...TEST_REPO, id: 'child', path: '/repo1/child' }
    useAppStore.setState({
      repos: [
        child,
        { ...TEST_REPO, kind: 'folder' },
        { ...TEST_REPO, id: 'outside', path: '/outside' }
      ],
      folderWorkspaces: [folder],
      projectGroups: []
    })
    expect(
      actionsCandidateRepos(useAppStore.getState(), `folder:${folder.id}`).map((repo) => repo.id)
    ).toEqual(['child'])
  })
})
