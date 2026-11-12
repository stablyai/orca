// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { expect, it, vi } from 'vitest'

import type { RuntimeFileListState } from './quick-open-file-list'
import {
  listRuntimeFilesMock,
  searchRuntimeFilePathsMock,
  seedRemoteWorktree,
  HookProbe,
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

it('shows ordinary results and starts the next query while recent validation is pending', async () => {
  vi.useFakeTimers()
  seedRemoteWorktree()
  const states: RuntimeFileListState[] = []
  searchRuntimeFilePathsMock.mockResolvedValue({ files: ['src/file0.ts'], truncated: true })
  let release: (files: string[]) => void = () => {
    throw new Error('Not started')
  }
  listRuntimeFilesMock.mockReturnValue(
    new Promise<string[]>((resolve) => {
      release = resolve
    })
  )
  const args = {
    enabled: true,
    worktreeId: 'wt-remote',
    query: 'file',
    recentPaths: ['src/file99.ts'],
    states
  }
  try {
    const root = await renderProbe(args)
    await act(async () => vi.advanceTimersByTimeAsync(320))
    expect(listRuntimeFilesMock).toHaveBeenCalledOnce()
    const signal = listRuntimeFilesMock.mock.calls[0][1].signal
    for (const query of ['file9', 'file99']) {
      await act(async () => {
        root.render(createElement(HookProbe, { ...args, query }))
      })
      await act(async () => vi.advanceTimersByTimeAsync(320))
    }
    expect(signal.aborted).toBe(true)
    expect(searchRuntimeFilePathsMock).toHaveBeenCalledTimes(3)
    expect(states.at(-1)?.files).toEqual(['src/file0.ts'])
    expect(states.at(-1)?.loading).toBe(false)
    await act(async () => {
      release(['src/file99.ts'])
    })
    await act(async () => vi.advanceTimersByTimeAsync(320))
    expect(searchRuntimeFilePathsMock).toHaveBeenCalledTimes(3)
    expect(searchRuntimeFilePathsMock.mock.calls[2][1].query).toBe('file99')
    expect(states.at(-1)?.files).toContain('src/file99.ts')
    expect(states.at(-1)?.loading).toBe(false)
  } finally {
    vi.useRealTimers()
  }
})
