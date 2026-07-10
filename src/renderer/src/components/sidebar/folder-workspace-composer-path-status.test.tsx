// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ProjectGroup } from '../../../../shared/types'
import { useAppStore } from '@/store'
import { useFolderWorkspaceComposerPathStatus } from './folder-workspace-composer-path-status'

const initialState = useAppStore.getInitialState()

const projectGroup: ProjectGroup = {
  id: 'group-1',
  name: 'Platform',
  parentPath: '/workspace/platform',
  connectionId: null,
  parentGroupId: null,
  createdFrom: 'folder-scan',
  tabOrder: 0,
  isCollapsed: false,
  color: null,
  createdAt: 1,
  updatedAt: 1
}
const projectGroupRequestSnapshot = '/workspace/platform\0group-1\0\0\0'

let root: Root | null = null
let container: HTMLDivElement | null = null

function HookProbe(): null {
  const result = useFolderWorkspaceComposerPathStatus(projectGroup, true)
  ;(
    globalThis as { __folderWorkspaceComposerPathStatusResult?: typeof result }
  ).__folderWorkspaceComposerPathStatusResult = result
  return null
}

describe('useFolderWorkspaceComposerPathStatus', () => {
  afterEach(() => {
    vi.useRealTimers()
    act(() => {
      root?.unmount()
    })
    root = null
    container?.remove()
    container = null
    delete (globalThis as { __folderWorkspaceComposerPathStatusResult?: unknown })
      .__folderWorkspaceComposerPathStatusResult
    useAppStore.setState(initialState, true)
  })

  it('blocks creation while an expired path status refresh is pending', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(20_000)
    const request = { scope: 'project-group' as const, projectGroupId: projectGroup.id }
    const cacheKey = useAppStore.getState().getFolderWorkspacePathStatusCacheKey(request)
    const fetchFolderWorkspacePathStatus = vi.fn().mockResolvedValue(null)
    useAppStore.setState({
      projectGroups: [projectGroup],
      fetchFolderWorkspacePathStatus,
      folderWorkspacePathStatuses: {
        [cacheKey]: {
          status: {
            path: '/workspace/platform',
            exists: false,
            reason: 'missing'
          },
          checkedAt: 0,
          requestSnapshot: projectGroupRequestSnapshot
        }
      }
    })
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)

    act(() => {
      root?.render(<HookProbe />)
    })

    expect(
      (
        globalThis as {
          __folderWorkspaceComposerPathStatusResult?: { pathStatusBlocksCreate: boolean }
        }
      ).__folderWorkspaceComposerPathStatusResult?.pathStatusBlocksCreate
    ).toBe(true)
    expect(
      (
        globalThis as {
          __folderWorkspaceComposerPathStatusResult?: { pathStatusProjectError: string | null }
        }
      ).__folderWorkspaceComposerPathStatusResult?.pathStatusProjectError
    ).toContain('/workspace/platform')

    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(
      (
        globalThis as {
          __folderWorkspaceComposerPathStatusResult?: { pathStatusBlocksCreate: boolean }
        }
      ).__folderWorkspaceComposerPathStatusResult?.pathStatusBlocksCreate
    ).toBe(true)
    expect(
      (
        globalThis as {
          __folderWorkspaceComposerPathStatusResult?: { pathStatusProjectError: string | null }
        }
      ).__folderWorkspaceComposerPathStatusResult?.pathStatusProjectError
    ).toContain('/workspace/platform')
    expect(fetchFolderWorkspacePathStatus).toHaveBeenCalledWith(request, { force: true })
  })

  it('unblocks creation when the first path status check settles without cache', async () => {
    const request = { scope: 'project-group' as const, projectGroupId: projectGroup.id }
    const fetchFolderWorkspacePathStatus = vi.fn().mockResolvedValue(null)
    useAppStore.setState({
      projectGroups: [projectGroup],
      fetchFolderWorkspacePathStatus,
      folderWorkspacePathStatuses: {}
    })
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)

    act(() => {
      root?.render(<HookProbe />)
    })

    expect(
      (
        globalThis as {
          __folderWorkspaceComposerPathStatusResult?: { pathStatusBlocksCreate: boolean }
        }
      ).__folderWorkspaceComposerPathStatusResult?.pathStatusBlocksCreate
    ).toBe(true)

    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(
      (
        globalThis as {
          __folderWorkspaceComposerPathStatusResult?: { pathStatusBlocksCreate: boolean }
        }
      ).__folderWorkspaceComposerPathStatusResult?.pathStatusBlocksCreate
    ).toBe(false)
    expect(fetchFolderWorkspacePathStatus).toHaveBeenCalledWith(request, { force: true })
  })

  it('blocks creation while the first path status check is unknown', () => {
    const request = { scope: 'project-group' as const, projectGroupId: projectGroup.id }
    const fetchFolderWorkspacePathStatus = vi.fn()
    useAppStore.setState({
      projectGroups: [projectGroup],
      fetchFolderWorkspacePathStatus,
      folderWorkspacePathStatuses: {}
    })
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)

    act(() => {
      root?.render(<HookProbe />)
    })

    expect(
      (
        globalThis as {
          __folderWorkspaceComposerPathStatusResult?: { pathStatusBlocksCreate: boolean }
        }
      ).__folderWorkspaceComposerPathStatusResult?.pathStatusBlocksCreate
    ).toBe(true)
    expect(fetchFolderWorkspacePathStatus).toHaveBeenCalledWith(request, { force: true })
  })

  it('does not block creation for an unavailable path status', () => {
    vi.useFakeTimers()
    vi.setSystemTime(20_000)
    const request = { scope: 'project-group' as const, projectGroupId: projectGroup.id }
    const cacheKey = useAppStore.getState().getFolderWorkspacePathStatusCacheKey(request)
    useAppStore.setState({
      projectGroups: [projectGroup],
      fetchFolderWorkspacePathStatus: vi.fn().mockResolvedValue(null),
      folderWorkspacePathStatuses: {
        [cacheKey]: {
          status: {
            path: '/workspace/platform',
            exists: false,
            reason: 'unavailable'
          },
          checkedAt: 20_000,
          requestSnapshot: projectGroupRequestSnapshot
        }
      }
    })
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)

    act(() => {
      root?.render(<HookProbe />)
    })

    expect(
      (
        globalThis as {
          __folderWorkspaceComposerPathStatusResult?: { pathStatusBlocksCreate: boolean }
        }
      ).__folderWorkspaceComposerPathStatusResult?.pathStatusBlocksCreate
    ).toBe(false)
  })

  it('blocks while refreshing after a cached blocking path status expires', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(20_000)
    const request = { scope: 'project-group' as const, projectGroupId: projectGroup.id }
    const cacheKey = useAppStore.getState().getFolderWorkspacePathStatusCacheKey(request)
    useAppStore.setState({
      projectGroups: [projectGroup],
      fetchFolderWorkspacePathStatus: vi.fn(),
      folderWorkspacePathStatuses: {
        [cacheKey]: {
          status: {
            path: '/workspace/platform',
            exists: false,
            reason: 'missing'
          },
          checkedAt: 20_000,
          requestSnapshot: projectGroupRequestSnapshot
        }
      }
    })
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)

    act(() => {
      root?.render(<HookProbe />)
    })
    expect(
      (
        globalThis as {
          __folderWorkspaceComposerPathStatusResult?: { pathStatusBlocksCreate: boolean }
        }
      ).__folderWorkspaceComposerPathStatusResult?.pathStatusBlocksCreate
    ).toBe(true)

    act(() => {
      vi.advanceTimersByTime(10_001)
    })

    expect(
      (
        globalThis as {
          __folderWorkspaceComposerPathStatusResult?: { pathStatusBlocksCreate: boolean }
        }
      ).__folderWorkspaceComposerPathStatusResult?.pathStatusBlocksCreate
    ).toBe(true)

    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(
      (
        globalThis as {
          __folderWorkspaceComposerPathStatusResult?: { pathStatusBlocksCreate: boolean }
        }
      ).__folderWorkspaceComposerPathStatusResult?.pathStatusBlocksCreate
    ).toBe(true)
  })

  it('tracks settled path status refreshes by cache key and expiry generation', () => {
    const source = useFolderWorkspaceComposerPathStatus.toString()
    expect(source).toContain('activePathStatusRefreshIdRef')
    expect(source).toContain('activePathStatusRefreshIdRef.current !== refreshId')
    expect(source).toContain('completedPathStatusRefreshKeys')
    expect(source).toContain('`${pathStatusCacheKey}:${cacheExpiryTick}`')
    expect(source).toContain('new Set(current).add(pathStatusRefreshKey)')
    expect(source).toContain('!completedPathStatusRefreshKeys.has(pathStatusRefreshKey)')
    expect(source).toContain('cachedBlockingPathStatus')
    expect(source).toContain('cachedPathStatusEntry.status.reason === "ambiguous-connection"')
  })
})
