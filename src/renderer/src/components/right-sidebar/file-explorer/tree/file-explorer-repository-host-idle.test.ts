// oxlint-disable-next-line typescript/triple-slash-reference -- The host globals are ambient declarations, not an importable module.
/// <reference path="../../../../../../types/build-constants.d.ts" />
import { afterEach, expect, it, vi } from 'vitest'
import type { GitRepositoryStatusRequest } from '../../../../../../shared/git/status/git-repository-status'
import { getRepositoryStatuses } from '../../../../../../main/git/source-control/repository-status'
import { FileExplorerRepositoryObserver } from './file-explorer-repository-observer'

const { realpath, lstat, git } = vi.hoisted(() => ({
  realpath: vi.fn(async (path: string) => path),
  lstat: vi.fn(async (path: string) => {
    if (path.endsWith('/.git')) {
      throw Object.assign(new Error('absent'), { code: 'ENOENT' })
    }
    return { isSymbolicLink: () => false, isDirectory: () => true }
  }),
  git: vi.fn()
}))
vi.mock('node:fs/promises', () => ({ realpath, lstat }))
vi.mock('../../../../../../main/wsl/filesystem/wsl-unc-access-gate', () => ({
  assertWslUncPathRunning: async () => {}
}))
vi.mock('../../../../../../main/git/runner', () => ({
  gitOptionalLocksDisabledEnv: () => ({}),
  gitExecFileAsync: git
}))
afterEach(() => {
  vi.useRealTimers()
  vi.clearAllMocks()
})

it.each([1000, 10000])(
  'settles %i absent inputs without host I/O over ten idle minutes',
  async (count) => {
    vi.useFakeTimers()
    const read = vi.fn(
      async (request: GitRepositoryStatusRequest, signal: AbortSignal) =>
        (await getRepositoryStatuses('/workspace', request, { signal })).repositoryStatuses
    )
    const supports = vi.fn(async () => true)
    const observer = new FileExplorerRepositoryObserver(read, () => {}, supports)
    observer.setFrontier(
      Array.from({ length: count }, (_, index) => ({ path: `folder${index}` })),
      []
    )
    observer.setVisible(true)
    try {
      await vi.advanceTimersByTimeAsync(1000)
      expect(read).toHaveBeenCalledTimes(count === 1000 ? 10 : 100)
      expect(realpath).toHaveBeenCalledTimes(count === 1000 ? 1010 : 10100)
      expect(lstat).toHaveBeenCalledTimes(count === 1000 ? 2000 : 20000)
      expect(git).not.toHaveBeenCalled()
      read.mockClear()
      realpath.mockClear()
      lstat.mockClear()
      supports.mockClear()
      await vi.advanceTimersByTimeAsync(600_000)
      expect(read).not.toHaveBeenCalled()
      expect(realpath).not.toHaveBeenCalled()
      expect(lstat).not.toHaveBeenCalled()
      expect(supports).not.toHaveBeenCalled()
      expect(vi.getTimerCount()).toBe(0)
      observer.setVisible(false)
      await vi.advanceTimersByTimeAsync(600_000)
      observer.setVisible(true)
      await vi.advanceTimersByTimeAsync(4000)
      expect(read).not.toHaveBeenCalled()
      expect(realpath).not.toHaveBeenCalled()
      expect(lstat).not.toHaveBeenCalled()
      expect(supports).not.toHaveBeenCalled()
    } finally {
      observer.dispose()
    }
  }
)
