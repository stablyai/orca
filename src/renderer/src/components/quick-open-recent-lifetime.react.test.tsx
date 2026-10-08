// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import type { RuntimeFileListState } from './quick-open-file-list'
import {
  listRuntimeFilesMock,
  searchRuntimeFilePathsMock,
  seedRemoteWorktree,
  HookProbe,
  renderProbe,
  makeRemoteWorktree
} from './quick-open-file-list-test-harness'

vi.mock('@/runtime/runtime-file-client', async () => {
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

it('revokes pending eligibility on close and owner change without overlapping host scans', async () => {
  vi.useFakeTimers()
  seedRemoteWorktree()
  const states: RuntimeFileListState[] = []
  let active = 0
  let maximumActive = 0
  let aborted = 0
  const releases: (() => void)[] = []
  searchRuntimeFilePathsMock.mockImplementation(() => {
    expect(active).toBe(0)
    return Promise.resolve({ files: ['src/file0.ts'], truncated: true })
  })
  listRuntimeFilesMock.mockImplementation((_context, options) => {
    active++
    maximumActive = Math.max(maximumActive, active)
    return new Promise<string[]>((resolve, reject) => {
      let ended = false
      const finish = (cancelled: boolean): void => {
        if (ended) {
          return
        }
        ended = true
        active--
        if (cancelled) {
          aborted++
          reject(new Error('aborted'))
        } else {
          resolve(['src/file99.ts'])
        }
      }
      releases.push(() => finish(false))
      options.signal.addEventListener('abort', () => finish(true), { once: true })
    })
  })
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
    for (const query of ['file9', 'file99']) {
      await act(async () => {
        root.render(createElement(HookProbe, { ...args, query }))
      })
      await act(async () => vi.advanceTimersByTimeAsync(320))
    }
    expect(listRuntimeFilesMock).toHaveBeenCalledTimes(3)
    expect(aborted).toBe(2)
    await act(async () => {
      root.render(createElement(HookProbe, { ...args, enabled: false }))
    })
    expect(aborted).toBe(3)
    expect(active).toBe(0)
    await act(async () => {
      root.render(createElement(HookProbe, args))
    })
    await act(async () => vi.advanceTimersByTimeAsync(320))
    await act(async () => {
      useAppStore.setState({
        worktreesByRepo: {
          'repo-remote': [
            { ...makeRemoteWorktree(), hostId: 'runtime:env-2', runtimeOwnerEnvironmentId: 'env-2' }
          ]
        }
      })
    })
    await act(async () => vi.advanceTimersByTimeAsync(320))
    expect(aborted).toBe(4)
    expect(listRuntimeFilesMock).toHaveBeenCalledTimes(5)
    await act(async () => {
      releases.at(-1)?.()
    })
    expect(active).toBe(0)
    expect(maximumActive).toBe(1)
    expect(searchRuntimeFilePathsMock).toHaveBeenCalledTimes(5)
    expect(states.at(-1)?.files).toContain('src/file99.ts')
    console.log(
      'ELIGIBILITY_FINAL_COUNTS',
      JSON.stringify({
        candidateStarts: listRuntimeFilesMock.mock.calls.length,
        candidateAborts: aborted,
        ordinaryStarts: searchRuntimeFilePathsMock.mock.calls.length,
        maximumActive,
        active
      })
    )
  } finally {
    vi.useRealTimers()
  }
})
