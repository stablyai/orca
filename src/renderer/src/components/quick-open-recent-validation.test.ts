import { beforeEach, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ list: vi.fn(), cancel: vi.fn() }))
vi.mock('@/runtime/files/runtime-file-request-debounce', () => ({
  debounceRuntimeFileRequest: (
    _delay: number,
    _signal: AbortSignal,
    request: () => Promise<unknown>
  ) => request()
}))
vi.mock('@/runtime/files/search/runtime-file-search-client', () => ({
  listRuntimeFiles: mocks.list,
  cancelRuntimeFileList: mocks.cancel
}))
import {
  clearQuickOpenRecentCache,
  mergeQuickOpenRecentCandidates,
  type QuickOpenRecentCache
} from './quick-open-recent-validation'
beforeEach(() => {
  vi.clearAllMocks()
})
const context = {
  target: { kind: 'local' as const },
  worktreeId: 'wt',
  worktreePath: '/repo'
}
it('shares pending eligibility across queries and rejects stale ordinary membership', async () => {
  const cache: QuickOpenRecentCache = { current: null }
  let release: (paths: string[]) => void = () => {
    throw new Error('Not started')
  }
  mocks.list.mockReturnValue(
    new Promise<string[]>((resolve) => {
      release = resolve
    })
  )
  let firstCancelled = false
  const args = {
    cache,
    key: 'palette',
    context,
    options: { rootPath: '/repo' },
    candidatePaths: ['recent.ts', 'deleted.ts'],
    result: { files: ['deleted.ts', 'ordinary.ts'], truncated: false }
  }
  const first = mergeQuickOpenRecentCandidates({ ...args, cancelled: () => firstCancelled })
  firstCancelled = true
  const second = mergeQuickOpenRecentCandidates({ ...args, cancelled: () => false })
  expect(mocks.list).toHaveBeenCalledOnce()
  release(['recent.ts'])
  expect(await first).toBeUndefined()
  expect(await second).toMatchObject({ files: ['ordinary.ts', 'recent.ts'] })
  expect(mocks.cancel).not.toHaveBeenCalled()
  clearQuickOpenRecentCache(cache)
  expect(mocks.cancel).not.toHaveBeenCalled()
})
it('cancels the producer on close and ignores its late result after reopening', async () => {
  const cache: QuickOpenRecentCache = { current: null }
  let release: (paths: string[]) => void = () => {
    throw new Error('Not started')
  }
  mocks.list
    .mockReturnValueOnce(
      new Promise<string[]>((resolve) => {
        release = resolve
      })
    )
    .mockResolvedValueOnce([])
  const args = {
    cache,
    key: 'palette',
    context,
    options: { rootPath: '/repo' },
    candidatePaths: ['deleted.ts'],
    result: { files: ['deleted.ts'], truncated: true },
    cancelled: () => false
  }
  const first = mergeQuickOpenRecentCandidates(args)
  const signal = mocks.list.mock.calls[0][1].signal
  clearQuickOpenRecentCache(cache)
  expect(signal.aborted).toBe(true)
  expect(mocks.cancel).toHaveBeenCalledOnce()
  const reopened = mergeQuickOpenRecentCandidates(args)
  expect(await reopened).toMatchObject({ files: [] })
  release(['deleted.ts'])
  expect(await first).toBeUndefined()
  expect(mocks.list).toHaveBeenCalledTimes(2)
})
