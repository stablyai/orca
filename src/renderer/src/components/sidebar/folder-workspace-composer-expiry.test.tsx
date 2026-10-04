// @vitest-environment happy-dom

import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProjectGroup } from '../../../../shared/project-group-types'
import { FOLDER_WORKSPACE_PATH_STATUS_TTL_MS } from '../../../../shared/folder-workspace-path-status'
import type { FolderWorkspacePathStatusCacheEntry } from '@/store/repos/repo-state'
import { useAppStore } from '@/store'
import { getFolderWorkspaceStatusRequestSnapshot } from '@/store/folder-workspaces/folder-path-status'
import { useFolderWorkspaceComposerPathStatus } from './folder-workspace-composer-path-status'

const initialState = useAppStore.getInitialState()
const group: ProjectGroup = {
  id: 'selected',
  name: 'Folder',
  parentPath: '/folder',
  parentGroupId: null,
  createdFrom: 'manual',
  tabOrder: 0,
  isCollapsed: false,
  color: null,
  createdAt: 0,
  updatedAt: 0
}
const request = { scope: 'project-group', projectGroupId: group.id } as const
const getPathStatus = vi.fn<Window['api']['folderWorkspaces']['getPathStatus']>()
let originalApi: PropertyDescriptor | undefined

function unrelatedEntries(): Record<string, FolderWorkspacePathStatusCacheEntry> {
  const entries: Record<string, FolderWorkspacePathStatusCacheEntry> = {}
  for (let index = 1; index <= 100; index += 1) {
    entries[`local:project-group:unrelated-${index}`] = {
      status: { path: `/unrelated-${index}`, exists: true },
      checkedAt: Date.now() - FOLDER_WORKSPACE_PATH_STATUS_TTL_MS + index * 10,
      requestSnapshot: 'unrelated'
    }
  }
  return entries
}

async function expireUnrelatedEntries(): Promise<void> {
  for (let index = 0; index < 1010; index += 1) {
    await act(async () => vi.advanceTimersByTimeAsync(1))
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(100_000)
  getPathStatus.mockReset().mockResolvedValue({ path: '/folder', exists: true })
  originalApi = Object.getOwnPropertyDescriptor(window, 'api')
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { folderWorkspaces: { getPathStatus } }
  })
  useAppStore.setState(
    {
      ...initialState,
      projectGroups: [group],
      folderWorkspaces: [],
      repos: [],
      folderWorkspacePathStatuses: unrelatedEntries(),
      settings: null
    },
    true
  )
})

afterEach(() => {
  cleanup()
  expect(vi.getTimerCount()).toBe(0)
  vi.restoreAllMocks()
  vi.useRealTimers()
  useAppStore.setState(initialState, true)
  if (originalApi) {
    Object.defineProperty(window, 'api', originalApi)
  } else {
    Reflect.deleteProperty(window, 'api')
  }
})

describe('folder composer cache expiry requests', () => {
  it('retains unrelated-expiry and reopen retries after an uncached failure', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    getPathStatus.mockRejectedValueOnce(new Error('Unavailable'))
    const hook = renderHook(({ open }) => useFolderWorkspaceComposerPathStatus(group, open, null), {
      initialProps: { open: true }
    })
    await act(async () => {})
    await expireUnrelatedEntries()
    expect(getPathStatus).toHaveBeenCalledTimes(2)
    expect(hook.result.current.pathStatusBlocksCreate).toBe(false)
    hook.rerender({ open: false })
    hook.rerender({ open: true })
    await act(async () => {})
    expect(getPathStatus).toHaveBeenCalledTimes(3)
    expect(hook.result.current.pathStatusBlocksCreate).toBe(false)
  })

  it('does not refetch a fresh selected folder when other entries expire', async () => {
    const hook = renderHook(() => useFolderWorkspaceComposerPathStatus(group, true, null))
    await act(async () => {})
    await expireUnrelatedEntries()

    expect(getPathStatus).toHaveBeenCalledExactlyOnceWith(request)
    expect(hook.result.current.pathStatusBlocksCreate).toBe(false)
  })

  it('retains expiry-triggered checks while the first result is unknown', async () => {
    const gate = Promise.withResolvers<{ path: string; exists: boolean }>()
    getPathStatus.mockReturnValue(gate.promise)
    const hook = renderHook(() => useFolderWorkspaceComposerPathStatus(group, true, null))
    await expireUnrelatedEntries()

    expect(getPathStatus).toHaveBeenCalledTimes(101)
    expect(hook.result.current.pathStatusBlocksCreate).toBe(true)
    await act(async () => gate.resolve({ path: '/folder', exists: true }))
    expect(hook.result.current.pathStatusBlocksCreate).toBe(false)
  })

  it('refreshes at the selected entry expiry and blocks while that refresh is pending', async () => {
    useAppStore.setState({ folderWorkspacePathStatuses: {} })
    const gate = Promise.withResolvers<{ path: string; exists: boolean }>()
    getPathStatus
      .mockResolvedValueOnce({ path: '/folder', exists: true })
      .mockReturnValueOnce(gate.promise)
    const hook = renderHook(() => useFolderWorkspaceComposerPathStatus(group, true, null))
    await act(async () => {})
    await act(async () => vi.advanceTimersByTimeAsync(FOLDER_WORKSPACE_PATH_STATUS_TTL_MS))
    expect(getPathStatus).toHaveBeenCalledOnce()
    await act(async () => vi.advanceTimersByTimeAsync(1))

    expect(getPathStatus).toHaveBeenCalledTimes(2)
    expect(hook.result.current.pathStatusBlocksCreate).toBe(true)
    await act(async () => gate.resolve({ path: '/folder', exists: true }))
    expect(hook.result.current.pathStatusBlocksCreate).toBe(false)
  })

  it('does not check a folder without a selected group', async () => {
    renderHook(() => useFolderWorkspaceComposerPathStatus(null, true, null))
    await expireUnrelatedEntries()
    expect(getPathStatus).not.toHaveBeenCalled()
  })

  it.each(['missing', 'not-directory', 'ambiguous-connection'] as const)(
    'retains unrelated-expiry recovery after a cached %s refresh fails',
    async (reason) => {
      vi.spyOn(console, 'error').mockImplementation(() => {})
      getPathStatus
        .mockResolvedValueOnce({ path: '/folder', exists: false, reason })
        .mockRejectedValueOnce(new Error('Unavailable'))
      const hook = renderHook(() => useFolderWorkspaceComposerPathStatus(group, true, null))
      await act(async () => {})
      await expireUnrelatedEntries()
      expect(getPathStatus).toHaveBeenCalledOnce()
      expect(hook.result.current.pathStatusBlocksCreate).toBe(true)
      await act(async () => vi.advanceTimersByTimeAsync(8991))
      expect(getPathStatus).toHaveBeenCalledTimes(2)
      expect(hook.result.current.pathStatusBlocksCreate).toBe(true)
      await act(async () => {
        useAppStore.setState((state) => ({
          folderWorkspacePathStatuses: {
            ...state.folderWorkspacePathStatuses,
            unrelated: {
              checkedAt: Date.now() - FOLDER_WORKSPACE_PATH_STATUS_TTL_MS + 10,
              requestSnapshot: '',
              status: { path: '/other', exists: true }
            }
          }
        }))
      })
      await act(async () => vi.advanceTimersByTimeAsync(11))
      expect(getPathStatus).toHaveBeenCalledTimes(3)
      expect(hook.result.current.pathStatusBlocksCreate).toBe(false)
    }
  )

  it('forces the initial check even when a matching fresh result is already cached', async () => {
    const snapshot = getFolderWorkspaceStatusRequestSnapshot(useAppStore.getState(), request)
    expect(snapshot).not.toBeNull()
    useAppStore.setState({
      folderWorkspacePathStatuses: {
        'local:project-group:selected': {
          checkedAt: Date.now(),
          requestSnapshot: snapshot ?? '',
          status: { path: '/folder', exists: false, reason: 'missing' }
        }
      }
    })
    const hook = renderHook(() => useFolderWorkspaceComposerPathStatus(group, true, null))
    await act(async () => {})
    expect(getPathStatus).toHaveBeenCalledExactlyOnceWith(request)
    expect(hook.result.current.pathStatusBlocksCreate).toBe(false)
  })

  it('retries a fresh timestamp whose request snapshot is no longer current', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    getPathStatus.mockRejectedValueOnce(new Error('Unavailable'))
    useAppStore.setState((state) => ({
      folderWorkspacePathStatuses: {
        ...state.folderWorkspacePathStatuses,
        'local:project-group:selected': {
          checkedAt: Date.now(),
          requestSnapshot: 'old-folder-snapshot',
          status: { path: '/old-folder', exists: false, reason: 'missing' }
        }
      }
    }))
    const hook = renderHook(() => useFolderWorkspaceComposerPathStatus(group, true, null))
    await act(async () => {})
    expect(hook.result.current.pathStatusBlocksCreate).toBe(true)
    await act(async () => vi.advanceTimersByTimeAsync(11))
    expect(getPathStatus).toHaveBeenCalledTimes(2)
    expect(hook.result.current.pathStatusBlocksCreate).toBe(false)
  })

  it('does not report a nonexistent pending check when cache is cleared after a skipped expiry', async () => {
    const hook = renderHook(() => useFolderWorkspaceComposerPathStatus(group, true, null))
    await act(async () => {})
    await act(async () => vi.advanceTimersByTimeAsync(11))
    expect(getPathStatus).toHaveBeenCalledOnce()
    await act(async () => useAppStore.setState({ folderWorkspacePathStatuses: {} }))
    expect(getPathStatus).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
    expect(hook.result.current.pathStatusBlocksCreate).toBe(false)
  })

  it('keeps a real pending check pending when fresh cache is removed after unrelated expiry', async () => {
    const snapshot = getFolderWorkspaceStatusRequestSnapshot(useAppStore.getState(), request)
    expect(snapshot).not.toBeNull()
    useAppStore.setState((state) => ({
      folderWorkspacePathStatuses: {
        ...state.folderWorkspacePathStatuses,
        'local:project-group:selected': {
          checkedAt: Date.now(),
          requestSnapshot: snapshot ?? '',
          status: { path: '/folder', exists: true }
        }
      }
    }))
    const gate = Promise.withResolvers<{ path: string; exists: boolean }>()
    getPathStatus.mockReturnValue(gate.promise)
    const hook = renderHook(() => useFolderWorkspaceComposerPathStatus(group, true, null))
    await act(async () => vi.advanceTimersByTimeAsync(11))
    expect(getPathStatus).toHaveBeenCalledTimes(2)
    await act(async () => useAppStore.setState({ folderWorkspacePathStatuses: {} }))
    expect(hook.result.current.pathStatusBlocksCreate).toBe(true)
    await act(async () => gate.resolve({ path: '/folder', exists: true }))
    expect(hook.result.current.pathStatusBlocksCreate).toBe(false)
  })

  it('uses the selected runtime cache entry instead of a same-group local entry', async () => {
    const fetchStatus = vi.fn().mockResolvedValue(null)
    const snapshot = getFolderWorkspaceStatusRequestSnapshot(useAppStore.getState(), request)
    expect(snapshot).not.toBeNull()
    const makeEntry = (checkedAt: number): FolderWorkspacePathStatusCacheEntry => ({
      checkedAt,
      status: { path: '/folder', exists: true },
      requestSnapshot: snapshot ?? ''
    })
    useAppStore.setState({
      fetchFolderWorkspacePathStatus: fetchStatus,
      folderWorkspacePathStatuses: {
        'local:project-group:selected': makeEntry(90_010),
        'environment:env-1:project-group:selected': makeEntry(100_000)
      }
    })
    const hook = renderHook(() => useFolderWorkspaceComposerPathStatus(group, true, 'env-1'))
    await act(async () => {})
    await act(async () => vi.advanceTimersByTimeAsync(11))
    expect(fetchStatus).toHaveBeenCalledExactlyOnceWith(request, {
      force: true,
      runtimeEnvironmentId: 'env-1'
    })
    expect(hook.result.current.pathStatusBlocksCreate).toBe(false)
    await act(async () => vi.advanceTimersByTimeAsync(9990))
    expect(fetchStatus).toHaveBeenCalledTimes(2)
  })

  it('replaces the timer when the selected group changes', async () => {
    const secondGroup: ProjectGroup = { ...group, id: 'second', parentPath: '/second' }
    useAppStore.setState({ projectGroups: [group, secondGroup], folderWorkspacePathStatuses: {} })
    getPathStatus.mockImplementation(async (input) => ({
      path:
        input.scope === 'project-group' && input.projectGroupId === 'second'
          ? '/second'
          : '/folder',
      exists: true
    }))
    const hook = renderHook(
      ({ selected }) => useFolderWorkspaceComposerPathStatus(selected, true, null),
      {
        initialProps: { selected: group }
      }
    )
    await act(async () => {})
    await act(async () => vi.advanceTimersByTimeAsync(5000))
    hook.rerender({ selected: secondGroup })
    await act(async () => {})
    getPathStatus.mockClear()
    await act(async () => vi.advanceTimersByTimeAsync(5001))
    expect(getPathStatus).not.toHaveBeenCalled()
    await act(async () => vi.advanceTimersByTimeAsync(5000))
    expect(getPathStatus).toHaveBeenCalledExactlyOnceWith({
      scope: 'project-group',
      projectGroupId: 'second'
    })
  })
})
