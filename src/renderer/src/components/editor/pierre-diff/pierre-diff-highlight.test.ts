import { beforeEach, expect, it, vi } from 'vitest'
import { parseDiffFromFile } from '@pierre/diffs'
import { preparePierreDiffHighlight } from './pierre-diff-highlight'

const pool = vi.hoisted(() => ({
  getDiffResultCache: vi.fn(),
  cleanUpTasks: vi.fn(),
  highlightDiffAST: vi.fn(),
  isWorkingPool: vi.fn(() => true)
}))
vi.mock('./pierre-diff-highlight-pool', () => ({ createDiffHighlightPool: () => pool }))
const diff = {
  ...parseDiffFromFile(null, { name: 'file.ts', contents: 'new' }),
  cacheKey: 'file:1'
}
beforeEach(() => {
  vi.resetAllMocks()
  pool.isWorkingPool.mockReturnValue(true)
})

it('waits for worker highlighting before handing a document to the editor', async () => {
  const promise = preparePierreDiffHighlight(diff, new AbortController().signal)
  expect(pool.highlightDiffAST).toHaveBeenCalledWith(expect.any(Object), diff)
  pool.highlightDiffAST.mock.calls[0][0].onHighlightSuccess()
  await promise
  expect(pool.cleanUpTasks).not.toHaveBeenCalled()
})

it('removes abandoned highlight requests and rejects stale completion', async () => {
  const controller = new AbortController()
  const promise = preparePierreDiffHighlight(diff, controller.signal)
  const rejection = expect(promise).rejects.toMatchObject({ name: 'AbortError' })
  controller.abort()
  pool.highlightDiffAST.mock.calls[0][0].onHighlightSuccess()
  await rejection
  expect(pool.cleanUpTasks).toHaveBeenCalled()
})

it('reuses cached highlighting and skips plain text', async () => {
  pool.getDiffResultCache.mockReturnValue({})
  await preparePierreDiffHighlight(diff, new AbortController().signal)
  pool.getDiffResultCache.mockReset()
  await preparePierreDiffHighlight({ ...diff, name: 'file.txt' }, new AbortController().signal)
  expect(pool.highlightDiffAST).not.toHaveBeenCalled()
})

it('keeps errors recoverable instead of falling back to blocking highlighting', async () => {
  const promise = preparePierreDiffHighlight(diff, new AbortController().signal)
  pool.highlightDiffAST.mock.calls[0][0].onHighlightError(new Error('worker failed'))
  await expect(promise).rejects.toThrow('worker failed')
  pool.isWorkingPool.mockReturnValue(false)
  await expect(preparePierreDiffHighlight(diff, new AbortController().signal)).rejects.toThrow(
    'unavailable'
  )
})

it('settles when the pool cancels a task without notifying the instance', async () => {
  // Why: Pierre's removeActiveTask rejects its own callbacks and drops the instance mapping in
  // clearInstanceRequests, but never calls onHighlightError. Without a ceiling this promise
  // pends forever and an editable surface awaiting it never renders.
  vi.useFakeTimers()
  try {
    const promise = preparePierreDiffHighlight(diff, new AbortController().signal)
    const rejection = expect(promise).rejects.toThrow('timed out')
    await vi.advanceTimersByTimeAsync(29_000)
    expect(pool.cleanUpTasks).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(2_000)
    await rejection
    expect(pool.cleanUpTasks).toHaveBeenCalledWith(pool.highlightDiffAST.mock.calls[0][0])
  } finally {
    vi.useRealTimers()
  }
})

it('treats a late cache fill as success instead of a timeout', async () => {
  vi.useFakeTimers()
  try {
    const promise = preparePierreDiffHighlight(diff, new AbortController().signal)
    pool.getDiffResultCache.mockReturnValue({})
    await vi.advanceTimersByTimeAsync(30_000)
    await promise
    expect(pool.cleanUpTasks).toHaveBeenCalled()
  } finally {
    vi.useRealTimers()
  }
})

it('detaches a timed-out highlight once even if it later notifies or aborts', async () => {
  vi.useFakeTimers()
  try {
    const controller = new AbortController()
    const promise = preparePierreDiffHighlight(diff, controller.signal)
    const renderer = pool.highlightDiffAST.mock.calls[0][0]
    const rejection = expect(promise).rejects.toThrow('timed out')
    await vi.advanceTimersByTimeAsync(30_000)
    await rejection
    renderer.onHighlightSuccess()
    controller.abort()
    expect(pool.cleanUpTasks).toHaveBeenCalledWith(renderer)
    expect(pool.cleanUpTasks).toHaveBeenCalledTimes(1)
  } finally {
    vi.useRealTimers()
  }
})
