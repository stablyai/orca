// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { FileDiffMetadata } from '@pierre/diffs'
import type { PierreDiffInput } from './pierre-diff-metadata'
import { usePierreFileDiff } from './use-pierre-file-diff'
import { requestPierreFileDiff } from './pierre-diff-parse-client'

vi.mock('./pierre-diff-parse-client', () => ({ requestPierreFileDiff: vi.fn() }))
const prepareHighlight = vi.hoisted(() => vi.fn())
vi.mock('./pierre-diff-highlight', () => ({ preparePierreDiffHighlight: prepareHighlight }))
const input: PierreDiffInput = {
  path: 'file',
  cacheKey: 'scope:file',
  status: 'modified',
  originalContent: 'old',
  modifiedContent: 'new',
  parseDiffOptions: {}
}
const diff = { name: 'file', hunks: [] } as unknown as FileDiffMetadata
beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.resetAllMocks()
})

it('cancels outdated computations and never installs their result', async () => {
  const completions: ((value: FileDiffMetadata) => void)[] = []
  vi.mocked(requestPierreFileDiff).mockImplementation(
    () => new Promise((resolve) => completions.push(resolve))
  )
  const { result, rerender } = renderHook(({ value }) => usePierreFileDiff(value), {
    initialProps: { value: input }
  })
  await act(async () => vi.runOnlyPendingTimers())
  const oldSignal = vi.mocked(requestPierreFileDiff).mock.calls[0][1]
  rerender({ value: { ...input, modifiedContent: 'latest' } })
  expect(oldSignal.aborted).toBe(true)
  await act(async () => vi.runOnlyPendingTimers())
  await act(async () => completions[0]({ ...diff, name: 'stale' }))
  expect(result.current.fileDiff).toBeNull()
  await act(async () => completions[1](diff))
  expect(result.current.fileDiff).toBe(diff)
})

it('keeps the mounted editor during a same-file update and coalesces rapid echoes', async () => {
  vi.mocked(requestPierreFileDiff).mockResolvedValue(diff)
  const { result, rerender } = renderHook(({ value }) => usePierreFileDiff(value), {
    initialProps: { value: input }
  })
  await act(async () => vi.runOnlyPendingTimers())
  expect(result.current.fileDiff).toBe(diff)
  rerender({ value: { ...input, modifiedContent: 'a' } })
  rerender({ value: { ...input, modifiedContent: 'ab' } })
  expect(result.current.fileDiff).toBe(diff)
  await act(async () => vi.advanceTimersByTime(120))
  expect(requestPierreFileDiff).toHaveBeenCalledTimes(2)
  expect(vi.mocked(requestPierreFileDiff).mock.calls[1][0].modifiedContent).toBe('ab')
})

it('never shows the preceding file under another file name', async () => {
  vi.mocked(requestPierreFileDiff).mockResolvedValue(diff)
  const { result, rerender } = renderHook(({ value }) => usePierreFileDiff(value), {
    initialProps: { value: input }
  })
  await act(async () => vi.runOnlyPendingTimers())
  rerender({ value: { ...input, path: 'another' } })
  expect(result.current.fileDiff).toBeNull()
})

it('exposes a recoverable error and retries in a worker', async () => {
  vi.mocked(requestPierreFileDiff)
    .mockRejectedValueOnce(new Error('failed'))
    .mockResolvedValueOnce(diff)
  const { result } = renderHook(() => usePierreFileDiff(input))
  await act(async () => vi.runOnlyPendingTimers())
  expect(result.current.error).toBe('failed')
  act(() => result.current.retry())
  await act(async () => vi.runOnlyPendingTimers())
  expect(result.current.error).toBeNull()
  expect(result.current.fileDiff).toBe(diff)
})

it('invalidates a pending result as soon as typing arrives, before the parent echoes it', async () => {
  let complete: (value: FileDiffMetadata) => void = () => {}
  vi.mocked(requestPierreFileDiff).mockImplementation(
    () =>
      new Promise((resolve) => {
        complete = resolve
      })
  )
  const { result } = renderHook(() => usePierreFileDiff(input))
  await act(async () => vi.runOnlyPendingTimers())
  act(() => result.current.markEdited())
  expect(vi.mocked(requestPierreFileDiff).mock.calls[0][1].aborted).toBe(true)
  await act(async () => complete(diff))
  expect(result.current.fileDiff).toBeNull()
})

it('keeps the last good diff when a later recompute fails', async () => {
  vi.mocked(requestPierreFileDiff).mockResolvedValueOnce(diff)
  const { result, rerender } = renderHook(({ value }) => usePierreFileDiff(value), {
    initialProps: { value: input }
  })
  await act(async () => vi.runOnlyPendingTimers())
  expect(result.current.fileDiff).toBe(diff)

  // A transient worker/queue failure must not unmount a live edit session.
  vi.mocked(requestPierreFileDiff).mockRejectedValueOnce(new Error('worker unavailable'))
  rerender({ value: { ...input, modifiedContent: 'edited' } })
  await act(async () => vi.runOnlyPendingTimers())
  expect(result.current.fileDiff).toBe(diff)
  expect(result.current.error).toBe('worker unavailable')
})

it('surfaces a detached highlight failure so the retry affordance still appears', async () => {
  // Why: a read-only diff no longer blocks on the highlight, but a dead worker pool used to
  // reject the request and give the user a way to recover.
  let reportError: ((error: unknown) => void) | undefined
  vi.mocked(requestPierreFileDiff).mockImplementation(async (_input, _signal, _block, onError) => {
    reportError = onError
    return diff
  })
  const { result } = renderHook(() => usePierreFileDiff(input))
  await act(async () => vi.runOnlyPendingTimers())
  expect(result.current.error).toBeNull()
  await act(async () => reportError?.(new Error('worker died')))
  expect(result.current.error).toBe('worker died')
  expect(result.current.fileDiff).toBe(diff)
})

it('does not re-parse when only editability flips, but primes the highlight', async () => {
  vi.mocked(requestPierreFileDiff).mockResolvedValue(diff)
  let finishPrime: (value: void) => void = () => {}
  prepareHighlight.mockImplementation(() => new Promise<void>((resolve) => (finishPrime = resolve)))
  const { result, rerender } = renderHook(({ editable }) => usePierreFileDiff(input, editable), {
    initialProps: { editable: false }
  })
  await act(async () => vi.runOnlyPendingTimers())
  expect(requestPierreFileDiff).toHaveBeenCalledTimes(1)
  expect(prepareHighlight).not.toHaveBeenCalled()
  expect(result.current.editReady).toBe(true)
  await act(async () => rerender({ editable: true }))
  // Staging/unstaging must not refetch identical content. The flip commit must also keep
  // `edit` off until the AST is primed -- Pierre's applyEdit runs in a child layout effect
  // of that same commit and would otherwise highlight the whole file synchronously.
  expect(requestPierreFileDiff).toHaveBeenCalledTimes(1)
  expect(prepareHighlight).toHaveBeenCalledWith(diff, expect.anything())
  expect(result.current.editReady).toBe(false)
  await act(async () => finishPrime())
  expect(result.current.editReady).toBe(true)
})

it('surfaces a prime-on-flip highlight failure so the retry affordance still appears', async () => {
  vi.mocked(requestPierreFileDiff).mockResolvedValue(diff)
  let failPrime: (error: Error) => void = () => {}
  prepareHighlight.mockImplementation(
    () => new Promise((_, reject) => (failPrime = reject as (error: Error) => void))
  )
  const { result, rerender } = renderHook(({ editable }) => usePierreFileDiff(input, editable), {
    initialProps: { editable: false }
  })
  await act(async () => vi.runOnlyPendingTimers())
  await act(async () => rerender({ editable: true }))
  expect(result.current.error).toBeNull()
  await act(async () => failPrime(new Error('worker died')))
  expect(result.current.error).toBe('worker died')
  expect(result.current.fileDiff).toBe(diff)
  expect(result.current.editReady).toBe(false)
})

it('clears a prime error when retry priming succeeds, before parse completes', async () => {
  vi.mocked(requestPierreFileDiff).mockResolvedValue(diff)
  let failPrime: (error: Error) => void = () => {}
  prepareHighlight.mockImplementation(
    () => new Promise((_, reject) => (failPrime = reject as (error: Error) => void))
  )
  const { result, rerender } = renderHook(({ editable }) => usePierreFileDiff(input, editable), {
    initialProps: { editable: false }
  })
  await act(async () => vi.runOnlyPendingTimers())
  await act(async () => rerender({ editable: true }))
  await act(async () => failPrime(new Error('worker died')))
  expect(result.current.error).toBe('worker died')

  let finishPrime: (value: void) => void = () => {}
  prepareHighlight.mockImplementation(() => new Promise<void>((resolve) => (finishPrime = resolve)))
  await act(async () => result.current.retry())
  // Same-file parse is coalesced 120ms; prime is not. Recovery must not wait on parse.
  expect(result.current.error).toBe('worker died')
  await act(async () => finishPrime())
  expect(result.current.editReady).toBe(true)
  expect(result.current.error).toBeNull()
})

it('re-primes on retry after a prime-on-flip highlight failure', async () => {
  vi.mocked(requestPierreFileDiff).mockResolvedValue(diff)
  let failPrime: (error: Error) => void = () => {}
  prepareHighlight.mockImplementation(
    () => new Promise((_, reject) => (failPrime = reject as (error: Error) => void))
  )
  const { result, rerender } = renderHook(({ editable }) => usePierreFileDiff(input, editable), {
    initialProps: { editable: false }
  })
  await act(async () => vi.runOnlyPendingTimers())
  await act(async () => rerender({ editable: true }))
  await act(async () => failPrime(new Error('worker died')))
  expect(result.current.editReady).toBe(false)
  expect(prepareHighlight).toHaveBeenCalledTimes(1)

  let finishPrime: (value: void) => void = () => {}
  prepareHighlight.mockImplementation(() => new Promise<void>((resolve) => (finishPrime = resolve)))
  await act(async () => result.current.retry())
  await act(async () => vi.runOnlyPendingTimers())
  expect(prepareHighlight).toHaveBeenCalledTimes(2)
  await act(async () => finishPrime())
  expect(result.current.editReady).toBe(true)
  expect(result.current.error).toBeNull()
})
