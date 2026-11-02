// @vitest-environment happy-dom

import { renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { GiteaWorkItem } from '../../../../shared/gitea-types'
import type { Repo } from '../../../../shared/repo-types'
import { useSmartWorkspaceGiteaSearch } from './use-smart-workspace-gitea-search'

const mocks = vi.hoisted(() => ({ resolve: vi.fn() }))
vi.mock('@/lib/gitea-work-item-source-lookup', () => ({
  resolveGiteaWorkItemsForQuery: mocks.resolve
}))

function item(overrides: Partial<GiteaWorkItem>): GiteaWorkItem {
  return {
    id: 'gitea-issue-1',
    type: 'issue',
    number: 1,
    title: 'Item',
    state: 'open',
    url: 'https://git.example.com/acme/app/issues/1',
    labels: [],
    updatedAt: '2026-01-01T00:00:00.000Z',
    author: null,
    repoId: 'repo-1',
    ...overrides
  }
}

const repo: Repo = {
  id: 'repo-1',
  path: '/work/app',
  displayName: 'app',
  badgeColor: '#000',
  addedAt: 0,
  connectionId: null
}

type Foundation = Parameters<typeof useSmartWorkspaceGiteaSearch>[0]['foundation']

function foundation(debouncedQuery = '#2') {
  const setGiteaItems = vi.fn()
  const setGiteaLoading = vi.fn()
  // SAFETY: the hook reads only these fields; the rest of the foundation is unrelated state.
  const value: Foundation = Object.assign(Object.create(null), {
    debouncedQuery,
    disabled: false,
    repoBackedSearchTargets: [{ repo, githubSourceContext: null, gitlabSourceContext: null }],
    mrStateFilter: 'opened',
    setGiteaItems,
    setGiteaLoading
  })
  return { value, setGiteaItems, setGiteaLoading }
}

describe('useSmartWorkspaceGiteaSearch', () => {
  beforeEach(() => {
    mocks.resolve.mockReset()
  })

  it('searches every target repo on its own host and keeps the newest items first', async () => {
    mocks.resolve.mockResolvedValue([
      item({ number: 1, updatedAt: '2026-01-01T00:00:00.000Z' }),
      item({ number: 2, updatedAt: '2026-02-01T00:00:00.000Z' })
    ])
    const { value, setGiteaItems, setGiteaLoading } = foundation()

    renderHook(() => useSmartWorkspaceGiteaSearch({ foundation: value, shouldQueryGitea: true }))

    await waitFor(() => expect(setGiteaItems).toHaveBeenLastCalledWith(expect.any(Array)))
    expect(mocks.resolve).toHaveBeenCalledWith(
      expect.objectContaining({
        repoPath: '/work/app',
        repoId: 'repo-1',
        repoOwnerExecutionHostId: 'local',
        query: '#2'
      })
    )
    const shown = setGiteaItems.mock.calls.at(-1)?.[0] as GiteaWorkItem[]
    expect(shown.map((entry) => entry.number)).toEqual([2, 1])
    await waitFor(() => expect(setGiteaLoading).toHaveBeenLastCalledWith(false))
  })

  it('clears results without searching while the Gitea source is inactive', () => {
    const { value, setGiteaItems, setGiteaLoading } = foundation()

    renderHook(() => useSmartWorkspaceGiteaSearch({ foundation: value, shouldQueryGitea: false }))

    expect(mocks.resolve).not.toHaveBeenCalled()
    expect(setGiteaItems).toHaveBeenCalledWith([])
    expect(setGiteaLoading).toHaveBeenCalledWith(false)
  })

  it('lists recent items for an empty query', async () => {
    mocks.resolve.mockResolvedValue([])
    const { value } = foundation('  ')

    renderHook(() => useSmartWorkspaceGiteaSearch({ foundation: value, shouldQueryGitea: true }))

    await waitFor(() => expect(mocks.resolve).toHaveBeenCalled())
    expect(mocks.resolve.mock.calls[0][0].query).toBeUndefined()
  })

  it('drops a failed repo instead of failing the whole search', async () => {
    mocks.resolve.mockRejectedValue(new Error('tea is not signed in'))
    const { value, setGiteaItems } = foundation()

    renderHook(() => useSmartWorkspaceGiteaSearch({ foundation: value, shouldQueryGitea: true }))

    await waitFor(() => expect(setGiteaItems).toHaveBeenLastCalledWith([]))
  })
})
