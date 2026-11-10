// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { folderWorkspaceKey } from '../../../shared/workspace-scope'

import { useAppStore } from '@/store'

import type { RuntimeFileListState } from './quick-open-file-list'

import {
  listRuntimeFilesMock,
  searchRuntimeFilePathsMock,
  makeProjectGroup,
  makeFolderWorkspace,
  seedRemoteWorktree,
  HookProbe,
  flushEffects,
  waitForListRuntimeFilesCall,
  renderProbe
} from './quick-open-file-list-test-harness'

vi.mock('@/runtime/files/search/runtime-file-search-client', async () => {
  const mocks = await import('./__mocks__/quick-open-runtime-file-client')
  return {
    listRuntimeFiles: mocks.listRuntimeFilesMock,
    cancelRuntimeFileList: mocks.cancelRuntimeFileListMock,
    searchRuntimeFilePaths: mocks.searchRuntimeFilePathsMock
  }
})

describe('useRuntimeFileListForWorktree', () => {
  it('settles a Windows folder listing failure and recovers after reopening', async () => {
    const workspaceKey = folderWorkspaceKey('folder-workspace-1')
    useAppStore.setState({
      folderWorkspaces: [makeFolderWorkspace({ folderPath: 'C:\\fixture', connectionId: null })],
      projectGroups: [makeProjectGroup({ parentPath: 'C:\\fixture', connectionId: null })],
      repos: [],
      worktreesByRepo: {}
    })
    listRuntimeFilesMock.mockRejectedValueOnce(new Error('fixture launcher failed'))
    const states: RuntimeFileListState[] = []
    const args = {
      enabled: true,
      worktreeId: workspaceKey,
      states
    }
    const root = await renderProbe(args)
    await waitForListRuntimeFilesCall()
    await flushEffects()
    expect(states.at(-1)?.loading).toBe(false)
    expect(states.at(-1)?.loadError).toBe('fixture launcher failed')
    await act(async () => {
      root.render(createElement(HookProbe, { ...args, enabled: false }))
    })
    listRuntimeFilesMock.mockResolvedValueOnce(['example.txt'])
    await act(async () => {
      root.render(createElement(HookProbe, args))
    })
    await flushEffects()
    expect(states.at(-1)?.loading).toBe(false)
    expect(states.at(-1)?.loadError).toBeNull()
    expect(states.at(-1)?.files).toEqual(['example.txt'])
  })

  it('aborts superseded runtime queries and ignores stale replies', async () => {
    vi.useFakeTimers()
    seedRemoteWorktree()
    const states: RuntimeFileListState[] = []
    let resolveFirst!: (value: { files: string[]; truncated: boolean }) => void
    let resolveSecond!: (value: { files: string[]; truncated: boolean }) => void
    searchRuntimeFilePathsMock
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirst = resolve
          })
      )
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveSecond = resolve
          })
      )

    try {
      const root = await renderProbe({
        enabled: true,
        states,
        query: 'tar',
        worktreeId: 'wt-remote'
      })
      await act(async () => vi.advanceTimersByTimeAsync(120))
      const firstSignal = searchRuntimeFilePathsMock.mock.calls[0]?.[1].signal as AbortSignal

      await act(async () => {
        root.render(
          createElement(HookProbe, {
            enabled: true,
            states,
            query: 'target',
            worktreeId: 'wt-remote'
          })
        )
      })
      expect(firstSignal.aborted).toBe(true)
      await act(async () => vi.advanceTimersByTimeAsync(120))

      await act(async () => {
        resolveSecond({ files: ['src/target.ts'], truncated: false })
        await Promise.resolve()
      })
      expect(states.at(-1)?.files).toEqual(['src/target.ts'])

      await act(async () => {
        resolveFirst({ files: ['src/stale-target.ts'], truncated: true })
        await Promise.resolve()
      })
      expect(states.at(-1)).toMatchObject({
        files: ['src/target.ts'],
        truncated: false
      })
    } finally {
      vi.useRealTimers()
    }
  })
})

it('keeps ordinary remote search available when recent eligibility is unsupported', async () => {
  vi.useFakeTimers()
  try {
    seedRemoteWorktree()
    const states: RuntimeFileListState[] = []
    searchRuntimeFilePathsMock.mockResolvedValue({ files: ['src/file0.ts'], truncated: true })
    listRuntimeFilesMock.mockRejectedValue(new Error('Update the remote host'))
    await renderProbe({
      enabled: true,
      worktreeId: 'wt-remote',
      query: 'file',
      recentPaths: ['src/file99.ts'],
      states
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400)
    })
    expect(states.at(-1)?.files).toEqual(['src/file0.ts'])
    expect(states.at(-1)?.loadError).toBeNull()
    expect(states.at(-1)?.recentError).toContain('Update the remote host')
  } finally {
    vi.useRealTimers()
  }
})
