// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { folderWorkspaceKey } from '../../../shared/workspace-scope'
import { useAppStore } from '@/store'
import type { RuntimeFileListState } from './quick-open-file-list'
import {
  listRuntimeFilesMock,
  searchRuntimeFilePathsMock,
  makeProjectGroup,
  makeFolderWorkspace,
  renderProbe
} from './quick-open-file-list-test-harness'

vi.mock('@/runtime/runtime-file-client', async () => {
  const mocks = await import('./__mocks__/quick-open-runtime-file-client')
  return {
    listRuntimeFiles: mocks.listRuntimeFilesMock,
    cancelRuntimeFileList: mocks.cancelRuntimeFileListMock,
    searchRuntimeFilePaths: mocks.searchRuntimeFilePathsMock
  }
})

function seedLocalFolder(): string {
  useAppStore.setState({
    folderWorkspaces: [makeFolderWorkspace({ folderPath: '/fixture/local', connectionId: null })],
    projectGroups: [makeProjectGroup({ parentPath: '/fixture/local', connectionId: null })],
    repos: [],
    worktreesByRepo: {}
  })
  return folderWorkspaceKey('folder-workspace-1')
}

describe('useRuntimeFileListForWorktree with a local path index', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('asks the local index per query and keeps its ranking', async () => {
    vi.useFakeTimers()
    const rankedPathSearch = vi.fn().mockResolvedValue(true)
    vi.stubGlobal('api', { fs: { rankedPathSearch } })
    searchRuntimeFilePathsMock.mockResolvedValue({
      files: ['src/use-effect.ts', 'src/usr-effect.ts'],
      truncated: false
    })
    const states: RuntimeFileListState[] = []

    await renderProbe({ enabled: true, states, query: 'usefect', worktreeId: seedLocalFolder() })
    await act(async () => vi.advanceTimersByTimeAsync(120))

    expect(rankedPathSearch).toHaveBeenCalledWith(
      expect.objectContaining({ rootPath: '/fixture/local' })
    )
    expect(searchRuntimeFilePathsMock).toHaveBeenCalledWith(
      expect.not.objectContaining({ connectionId: expect.anything() }),
      expect.objectContaining({ query: 'usefect' })
    )
    expect(listRuntimeFilesMock).not.toHaveBeenCalled()
    expect(states.at(-1)).toMatchObject({
      files: ['src/use-effect.ts', 'src/usr-effect.ts'],
      hostRanked: true,
      loading: false
    })
  })

  it('lists and ranks in the renderer when no local index serves the root', async () => {
    vi.stubGlobal('api', { fs: { rankedPathSearch: vi.fn().mockResolvedValue(false) } })
    const states: RuntimeFileListState[] = []

    await renderProbe({ enabled: true, states, query: 'package', worktreeId: seedLocalFolder() })
    await act(async () => {
      await Promise.resolve()
    })

    expect(searchRuntimeFilePathsMock).not.toHaveBeenCalled()
    expect(listRuntimeFilesMock).toHaveBeenCalledOnce()
    expect(states.at(-1)).toMatchObject({ files: ['packages/app/package.json'], hostRanked: false })
  })
})
