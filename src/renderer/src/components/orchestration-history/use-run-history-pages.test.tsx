// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RuntimeRpcCallError } from '@/runtime/runtime-rpc-result'
import { useRunHistoryPages, type HistoryPage } from './use-run-history-pages'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('run history page requests', () => {
  it('aborts and ignores a previous host response after the owner changes', async () => {
    const old = Promise.withResolvers<HistoryPage<string>>()
    let oldSignal: AbortSignal | undefined
    const loadA = (_cursor: string | undefined, signal: AbortSignal) => {
      oldSignal = signal
      return old.promise
    }
    const loadB = async () => ({ rows: ['host B'], nextCursor: null })
    const hook = renderHook(({ load }) => useRunHistoryPages(load), {
      initialProps: { load: loadA }
    })
    await act(async () => hook.rerender({ load: loadB }))
    expect(oldSignal?.aborted).toBe(true)
    expect(hook.result.current.rows).toEqual(['host B'])
    await act(async () => old.resolve({ rows: ['host A'], nextCursor: null }))
    expect(hook.result.current.rows).toEqual(['host B'])
  })

  it('keeps loaded events on page failure and retries the same cursor without duplicate requests', async () => {
    const second = Promise.withResolvers<HistoryPage<string>>()
    const load = vi
      .fn<(cursor: string | undefined, signal: AbortSignal) => Promise<HistoryPage<string>>>()
      .mockResolvedValueOnce({ rows: ['first'], nextCursor: 'page-2' })
      .mockReturnValueOnce(second.promise)
      .mockResolvedValueOnce({ rows: ['second'], nextCursor: null })
    const { result } = renderHook(() => useRunHistoryPages(load))
    await act(async () => {})
    act(() => {
      result.current.loadMore()
      result.current.loadMore()
    })
    expect(load).toHaveBeenCalledTimes(2)
    await act(async () => second.reject(new Error('offline')))
    expect(result.current.rows).toEqual(['first'])
    expect(result.current.error).toBe('failed')
    await act(async () => result.current.retry())
    expect(result.current.rows).toEqual(['first', 'second'])
    expect(result.current.error).toBeNull()
    expect(load.mock.calls.map(([cursor]) => cursor)).toEqual([undefined, 'page-2', 'page-2'])
  })

  it('refreshes the snapshot and ignores the old page still in flight', async () => {
    const oldPage = Promise.withResolvers<HistoryPage<string>>()
    const load = vi
      .fn()
      .mockResolvedValueOnce({ rows: ['old snapshot'], nextCursor: 'next' })
      .mockReturnValueOnce(oldPage.promise)
      .mockResolvedValueOnce({ rows: ['new snapshot'], nextCursor: null })
    const { result } = renderHook(() => useRunHistoryPages<string>(load))
    await act(async () => {})
    act(() => result.current.loadMore())
    await act(async () => result.current.refresh())
    await act(async () => oldPage.resolve({ rows: ['old page'], nextCursor: null }))
    expect(result.current.rows).toEqual(['new snapshot'])
  })

  it('shows loading only after the delay and clears it when the request settles', async () => {
    vi.useFakeTimers()
    const pending = Promise.withResolvers<HistoryPage<string>>()
    const load = () => pending.promise
    const { result } = renderHook(() => useRunHistoryPages(load))
    expect(result.current.loading).toBe(true)
    act(() => vi.advanceTimersByTime(199))
    expect(result.current.loadingVisible).toBe(false)
    act(() => vi.advanceTimersByTime(1))
    expect(result.current.loadingVisible).toBe(true)
    await act(async () => pending.resolve({ rows: [], nextCursor: null }))
    expect(result.current.loadingVisible).toBe(false)
    expect(result.current.loading).toBe(false)
  })

  it.each([
    ['method_not_found', 'unsupported'],
    ['cursor_invalid', 'expired']
  ])('keeps the %s remedy distinct', async (code, expected) => {
    const error = new RuntimeRpcCallError({
      id: 'req',
      ok: false,
      error: { code, message: code },
      _meta: { runtimeId: 'host' }
    })
    const load = async (): Promise<HistoryPage<string>> => {
      throw error
    }
    const { result } = renderHook(() => useRunHistoryPages(load))
    await act(async () => {})
    expect(result.current.error).toBe(expected)
    expect(result.current.rows).toEqual([])
  })
})
