// @vitest-environment happy-dom

import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import type { RuntimeFileListState } from '@/components/quick-open-file-list'
import { useFileExplorerNameFilter } from './use-file-explorer-name-filter'

const useRuntimeFileListForWorktreeMock = vi.hoisted(() => vi.fn())

vi.mock('@/components/quick-open-file-list', () => ({
  useRuntimeFileListForWorktree: useRuntimeFileListForWorktreeMock
}))

const emptyState: RuntimeFileListState = {
  files: [],
  loading: false,
  loadError: null
}

describe('useFileExplorerNameFilter', () => {
  beforeEach(() => {
    useRuntimeFileListForWorktreeMock.mockReset().mockReturnValue(emptyState)
    useAppStore.setState({ activeWorktreeId: 'worktree-1' })
  })

  afterEach(() => {
    cleanup()
  })

  it('passes the active filename query to the runtime path search', () => {
    const { result } = renderHook(() =>
      useFileExplorerNameFilter({ isFilesViewActive: true, activeWorktreeId: 'worktree-1' })
    )

    act(() => result.current.setNameFilterQuery('AppDelegate.swift'))

    expect(useRuntimeFileListForWorktreeMock).toHaveBeenLastCalledWith({
      enabled: true,
      worktreeId: 'worktree-1',
      query: 'AppDelegate.swift',
      hostFilterWhenCapped: true
    })
    expect(result.current.nameFilterSource?.query).toBe('AppDelegate.swift')
  })

  it('projects the settled listing for the active query', () => {
    useRuntimeFileListForWorktreeMock.mockReturnValue({
      files: ['package.json', 'src/main.ts'],
      loading: false,
      loadError: null
    } satisfies RuntimeFileListState)

    const { result } = renderHook(() =>
      useFileExplorerNameFilter({ isFilesViewActive: true, activeWorktreeId: 'worktree-1' })
    )

    act(() => result.current.setNameFilterQuery('package.'))

    expect(result.current.nameFilterSource?.relativePaths).toEqual(['package.json', 'src/main.ts'])
  })

  it('reports an unsettled source while the listing loads', () => {
    useRuntimeFileListForWorktreeMock.mockReturnValue({
      files: [],
      loading: true,
      loadError: null
    } satisfies RuntimeFileListState)

    const { result } = renderHook(() =>
      useFileExplorerNameFilter({ isFilesViewActive: true, activeWorktreeId: 'worktree-1' })
    )

    act(() => result.current.setNameFilterQuery('package.'))

    expect(result.current.nameFilterSource?.relativePaths).toBeNull()
  })
})
