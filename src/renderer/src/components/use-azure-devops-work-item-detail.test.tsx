// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { useAppStore } from '@/store'
import type { AzureDevOpsWorkItem } from '../../../shared/azure-devops/boards-types'
import type { Repo } from '../../../shared/repo-types'
import { useAzureDevOpsWorkItemDetail } from './use-azure-devops-work-item-detail'

const api = { getWorkItem: vi.fn() }
// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the hook reads window.api.azureDevOpsBoards.getWorkItem only.
;(window as unknown as { api: unknown }).api = { azureDevOpsBoards: api }

const initialState = useAppStore.getInitialState()
// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the hook reads only id, path and connectionId off the repo.
const repo = { id: 'repo-a', path: '/a', connectionId: null } as unknown as Repo

function boardItem(id: number): AzureDevOpsWorkItem {
  return {
    id,
    rev: 1,
    workItemType: 'Product Backlog Item',
    title: `Item ${id}`,
    state: 'Approved',
    assignedTo: null,
    areaPath: 'Project\\Web',
    iterationPath: 'Project',
    tags: [],
    parentId: null,
    stackRank: id,
    url: '',
    fields: {}
  }
}

describe('useAzureDevOpsWorkItemDetail', () => {
  beforeEach(() => {
    useAppStore.setState(initialState, true)
    api.getWorkItem.mockReset()
    api.getWorkItem.mockResolvedValue({
      ...boardItem(101),
      descriptionHtml: null,
      acceptanceCriteriaHtml: null,
      childIds: [301],
      children: [boardItem(301)],
      pullRequestLinks: [],
      createdDate: null,
      changedDate: null
    })
  })
  afterEach(() => {
    cleanup()
    useAppStore.setState(initialState, true)
  })

  it('names the items it already holds, so the host hydrates only the missing children', async () => {
    const cache = new Map([[101, boardItem(101)]])
    const { result } = renderHook(() => useAzureDevOpsWorkItemDetail(repo, cache))
    act(() => result.current.setDetailId(101))
    await waitFor(() => expect(result.current.detail?.id).toBe(101))
    expect(api.getWorkItem).toHaveBeenCalledWith(
      expect.objectContaining({ id: 101, cachedIds: [101] })
    )
    expect(result.current.detail?.children?.map((c) => c.id)).toEqual([301])
  })
})
