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

  it('does not block creation with an expired negative path status', () => {
    vi.useFakeTimers()
    vi.setSystemTime(20_000)
    const request = { scope: 'project-group' as const, projectGroupId: projectGroup.id }
    const cacheKey = useAppStore.getState().getFolderWorkspacePathStatusCacheKey(request)
    const fetchFolderWorkspacePathStatus = vi.fn()
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
    ).toBe(false)
    expect(
      (
        globalThis as {
          __folderWorkspaceComposerPathStatusResult?: { pathStatusProjectError: string | null }
        }
      ).__folderWorkspaceComposerPathStatusResult?.pathStatusProjectError
    ).toBeNull()
    expect(fetchFolderWorkspacePathStatus).toHaveBeenCalledWith(request, { force: true })
  })

  it('does not block creation for an unavailable path status', () => {
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

  it('rerenders when a cached blocking path status expires', () => {
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
    ).toBe(false)
  })
})
