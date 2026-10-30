// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { useAppStore } from '@/store'
import type { AzureDevOpsAssignedWorkItemsPage } from '../../../shared/azure-devops/boards-types'
import type { Repo } from '../../../shared/repo-types'
import type { AzureDevOpsTaskView } from './task-page-azure-devops-team-selection-persistence'
import { useAzureDevOpsWorkItemsLoader } from './use-azure-devops-work-items-loader'

const api = { loadAssignedWorkItems: vi.fn() }
// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the loader reads window.api.azureDevOpsBoards.loadAssignedWorkItems only.
;(window as unknown as { api: unknown }).api = { azureDevOpsBoards: api }

const initialState = useAppStore.getInitialState()

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the loader reads only id, path and connectionId off the repo.
const repo = { id: 'repo-a', path: '/a', connectionId: null } as unknown as Repo

function page(ids: number[]): AzureDevOpsAssignedWorkItemsPage {
  return {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the loader passes items through untouched; only the ids are asserted here.
    items: ids.map((id) => ({ id }) as AzureDevOpsAssignedWorkItemsPage['items'][number]),
    unhydratedItemCount: 0
  }
}

function render(view: AzureDevOpsTaskView = 'workItems') {
  return renderHook(
    (props: { view: AzureDevOpsTaskView }) =>
      useAzureDevOpsWorkItemsLoader({ active: true, repo, view: props.view }),
    { initialProps: { view } }
  )
}

describe('useAzureDevOpsWorkItemsLoader', () => {
  beforeEach(() => {
    useAppStore.setState(initialState, true)
    api.loadAssignedWorkItems.mockReset()
    api.loadAssignedWorkItems.mockResolvedValue(page([7, 3]))
  })
  afterEach(() => {
    cleanup()
    vi.useRealTimers()
  })

  it('loads the assigned items once the Work items view is shown, keyed by repo alone', async () => {
    const { result } = render()
    await waitFor(() => expect(result.current.status).toBe('ready'))
    expect(result.current.items.map((i) => i.id)).toEqual([7, 3])
    expect(api.loadAssignedWorkItems).toHaveBeenCalledTimes(1)
    expect(api.loadAssignedWorkItems).toHaveBeenCalledWith({
      repoPath: '/a',
      repoId: 'repo-a',
      connectionId: null
    })
  })

  it('requests nothing while another view is shown', () => {
    const { result } = render('backlog')
    expect(result.current.status).toBe('idle')
    expect(api.loadAssignedWorkItems).not.toHaveBeenCalled()
  })

  it('serves the cache on a view switch and refetches only on refresh', async () => {
    const { result, rerender } = render()
    await waitFor(() => expect(result.current.status).toBe('ready'))
    rerender({ view: 'backlog' })
    rerender({ view: 'workItems' })
    await waitFor(() => expect(result.current.status).toBe('ready'))
    expect(api.loadAssignedWorkItems).toHaveBeenCalledTimes(1)

    api.loadAssignedWorkItems.mockResolvedValue(page([9]))
    act(() => result.current.refresh())
    await waitFor(() => expect(result.current.items.map((i) => i.id)).toEqual([9]))
    expect(api.loadAssignedWorkItems).toHaveBeenCalledTimes(2)
  })

  it('reports a failure as an error rather than as nothing assigned', async () => {
    api.loadAssignedWorkItems.mockRejectedValue(new Error('HTTP 500'))
    const { result } = render()
    await waitFor(() => expect(result.current.status).toBe('error'))
    expect(result.current.errorStatus).toBe('error')
    expect(result.current.errorMessage).toContain('HTTP 500')
    expect(result.current.items).toEqual([])
  })

  it('separates an unreachable host from a query failure', async () => {
    api.loadAssignedWorkItems.mockRejectedValue(new Error('azure_devops_repo_unverifiable'))
    const { result } = render()
    await waitFor(() => expect(result.current.errorStatus).toBe('host-unreachable'))
  })

  it('surfaces the host’s omitted-item count so the view can say the list is short', async () => {
    api.loadAssignedWorkItems.mockResolvedValue({ items: [], unhydratedItemCount: 4 })
    const { result } = render()
    await waitFor(() => expect(result.current.unhydratedItemCount).toBe(4))
  })

  it('reads an older host’s page with no unhydrated count as nothing missing', async () => {
    api.loadAssignedWorkItems.mockResolvedValue({ items: [] })
    const { result } = render()
    await waitFor(() => expect(result.current.status).toBe('ready'))
    expect(result.current.unhydratedItemCount).toBe(0)
  })
})
