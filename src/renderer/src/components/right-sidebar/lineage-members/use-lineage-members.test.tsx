// why: the hook renders through React DOM, so @vitest-environment happy-dom

import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  LineageGetMembersArgs,
  LineageGetMembersResult
} from '../../../../../shared/fleet-lineage-types'
import type { LineageMember } from '../../../../../shared/lineage-discovery-types'
import { useAppStore } from '@/store'
import { useLineageMembers } from './use-lineage-members'

const initialAppState = useAppStore.getInitialState()
const originalApi = window.api
const getMembers = vi.fn<(args: LineageGetMembersArgs) => Promise<LineageGetMembersResult>>()

function memberFor(repoName: string): LineageMember {
  return { repoName, branch: 'feat/ABC-1', matchedBy: 'pattern', reasons: [] }
}

function installGitApi(git: Partial<typeof window.api.git>): void {
  Object.defineProperty(window, 'api', {
    configurable: true,
    writable: true,
    value: { ...originalApi, git }
  })
}

beforeEach(() => {
  getMembers.mockReset()
  useAppStore.setState(initialAppState, true)
  installGitApi({ lineageGetMembers: getMembers })
})

afterEach(() => {
  cleanup()
  Object.defineProperty(window, 'api', {
    configurable: true,
    writable: true,
    value: originalApi
  })
})

describe('useLineageMembers', () => {
  it('returns the members of the tower', async () => {
    getMembers.mockResolvedValue({
      parentWorkspaceKey: 'folder:t',
      keys: ['ABC-1'],
      members: [memberFor('api')]
    })

    const { result } = renderHook(() => useLineageMembers('folder:t'))

    await waitFor(() => expect(result.current.members).toHaveLength(1))
    expect(result.current.supported).toBe(true)
    expect(result.current.loading).toBe(false)
    expect(getMembers).toHaveBeenCalledWith({ parentWorkspaceKey: 'folder:t' })
  })

  it('reports unsupported without throwing when the host rejects', async () => {
    getMembers.mockRejectedValue(new Error('No handler registered'))

    const { result } = renderHook(() => useLineageMembers('folder:t'))

    await waitFor(() => expect(result.current.supported).toBe(false))
    expect(result.current.members).toEqual([])
  })

  it('reports unsupported when the host has no lineage api', async () => {
    installGitApi({})

    const { result } = renderHook(() => useLineageMembers('folder:t'))

    await waitFor(() => expect(result.current.supported).toBe(false))
    expect(result.current.members).toEqual([])
  })

  it('does not ask the host without a workspace key', () => {
    const { result } = renderHook(() => useLineageMembers(null))

    expect(result.current.members).toEqual([])
    expect(getMembers).not.toHaveBeenCalled()
  })

  it('never shows the previous tower members after the key changes', async () => {
    getMembers.mockResolvedValueOnce({
      parentWorkspaceKey: 'folder:a',
      keys: [],
      members: [memberFor('api')]
    })
    getMembers.mockReturnValueOnce(new Promise(() => {}))

    const { result, rerender } = renderHook(({ key }) => useLineageMembers(key), {
      initialProps: { key: 'folder:a' }
    })
    await waitFor(() => expect(result.current.members).toHaveLength(1))

    rerender({ key: 'folder:b' })

    expect(result.current.members).toEqual([])
  })

  it('refreshes when workspace lineage changes', async () => {
    getMembers.mockResolvedValue({
      parentWorkspaceKey: 'folder:t',
      keys: [],
      members: []
    })
    renderHook(() => useLineageMembers('folder:t'))
    await waitFor(() => expect(getMembers).toHaveBeenCalledTimes(1))

    useAppStore.setState({ workspaceLineageByChildKey: {} })

    await waitFor(() => expect(getMembers).toHaveBeenCalledTimes(2))
  })

  it('bypasses the host scan cache only on an explicit refresh', async () => {
    getMembers.mockResolvedValue({ parentWorkspaceKey: 'folder:t', keys: [], members: [] })
    const { result } = renderHook(() => useLineageMembers('folder:t'))
    await waitFor(() => expect(getMembers).toHaveBeenCalledTimes(1))
    expect(getMembers).toHaveBeenLastCalledWith({ parentWorkspaceKey: 'folder:t' })

    await act(async () => {
      await result.current.refresh()
    })

    expect(getMembers).toHaveBeenLastCalledWith({ parentWorkspaceKey: 'folder:t', force: true })
  })

  it('a refresh in one tab re-fetches every other mounted reader of the same tower', async () => {
    getMembers.mockResolvedValue({ parentWorkspaceKey: 'folder:t', keys: [], members: [] })
    const checks = renderHook(() => useLineageMembers('folder:t'))
    renderHook(() => useLineageMembers('folder:t'))
    renderHook(() => useLineageMembers('folder:other'))
    await waitFor(() => expect(getMembers).toHaveBeenCalledTimes(3))
    getMembers.mockClear()
    getMembers.mockResolvedValue({
      parentWorkspaceKey: 'folder:t',
      keys: [],
      members: [memberFor('api')]
    })

    await act(async () => {
      await checks.result.current.refresh()
    })

    await waitFor(() => expect(getMembers).toHaveBeenCalledTimes(2))
    expect(getMembers.mock.calls.map(([args]) => args)).toEqual([
      { parentWorkspaceKey: 'folder:t', force: true },
      { parentWorkspaceKey: 'folder:t' }
    ])
  })
})
