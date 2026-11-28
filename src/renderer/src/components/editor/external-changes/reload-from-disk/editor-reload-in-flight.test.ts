// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { runEditorReloadExclusive, useEditorReloadInFlight } from './editor-reload-in-flight'

function deferred(): { promise: Promise<string>; resolve: (value: string) => void } {
  let resolve!: (value: string) => void
  const promise = new Promise<string>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

describe('editor reload in-flight state', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('runs one reload per file and ignores a second click while it runs', async () => {
    const read = deferred()
    const first = runEditorReloadExclusive('a', () => read.promise, { showSpinner: true })
    const second = await runEditorReloadExclusive('a', async () => 'second', { showSpinner: true })
    expect(second).toBeNull()
    read.resolve('first')
    expect(await first).toBe('first')
  })

  it('keeps a fast read free of any spinner', async () => {
    const { result } = renderHook(() => useEditorReloadInFlight('fast'))
    const read = deferred()
    let run!: Promise<string | null>
    act(() => {
      run = runEditorReloadExclusive('fast', () => read.promise, { showSpinner: true })
    })
    expect(result.current).toEqual({ busy: true, spinner: false })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(150)
      read.resolve('done')
      await run
    })
    expect(result.current).toEqual({ busy: false, spinner: false })
  })

  it('shows the spinner after 200 ms and holds it at least 300 ms', async () => {
    const { result } = renderHook(() => useEditorReloadInFlight('slow'))
    const read = deferred()
    let run!: Promise<string | null>
    act(() => {
      run = runEditorReloadExclusive('slow', () => read.promise, { showSpinner: true })
    })
    await act(() => vi.advanceTimersByTimeAsync(199))
    expect(result.current.spinner).toBe(false)
    await act(() => vi.advanceTimersByTimeAsync(1))
    expect(result.current).toEqual({ busy: true, spinner: true })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10)
      read.resolve('done')
      await run
    })
    // Still held (and still guarding clicks) until 300 ms after the spinner appeared.
    expect(result.current.spinner).toBe(true)
    expect(
      await runEditorReloadExclusive('slow', async () => 'x', { showSpinner: true })
    ).toBeNull()
    await act(() => vi.advanceTimersByTimeAsync(290))
    expect(result.current).toEqual({ busy: false, spinner: false })
  })
})
