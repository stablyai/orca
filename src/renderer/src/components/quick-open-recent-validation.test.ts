import { beforeEach, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ list: vi.fn(), cancel: vi.fn() }))
vi.mock('@/runtime/runtime-file-request-debounce', () => ({
  debounceRuntimeFileRequest: (
    _delay: number,
    _signal: AbortSignal,
    request: () => Promise<unknown>
  ) => request()
}))
vi.mock('@/runtime/runtime-file-client', () => ({
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
it('cancels eligibility on owner/root changes while preserving ordinary search on errors', async () => {
  const cache: QuickOpenRecentCache = { current: null }
  mocks.list.mockRejectedValue(new Error('Update host'))
  const result = await mergeQuickOpenRecentCandidates({
    cache,
    key: 'root-a',
    context,
    options: { rootPath: '/repo' },
    candidatePaths: ['recent.ts'],
    result: { files: ['recent.ts', 'ordinary.ts'], truncated: true },
    cancelled: () => false
  })
  expect(result?.files).toEqual(['recent.ts', 'ordinary.ts'])
  expect(result?.recentError).toBe('Recent files could not be checked: Update host')
})

it('uses fresh complete inventory membership without a second traversal', async () => {
  const result = { files: ['ordinary.ts', 'recent.ts'], truncated: false }
  expect(
    await mergeQuickOpenRecentCandidates({
      result,
      completeInventory: true,
      candidatePaths: ['recent.ts', 'deleted.ts'],
      cache: { current: null },
      key: 'full',
      context,
      options: { rootPath: '/repo' },
      cancelled: () => false
    })
  ).toBe(result)
  expect(mocks.list).not.toHaveBeenCalled()
})
