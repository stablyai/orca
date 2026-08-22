import { afterEach, describe, expect, it, vi } from 'vitest'
import { waitForHostGeneratedBrowserPublication } from './web-runtime-browser-publication-wait'

afterEach(() => vi.useRealTimers())

describe('host-generated browser publication wait', () => {
  it('accepts subscription publication without another inventory request', async () => {
    vi.useFakeTimers()
    let materialized = false
    const refresh = vi.fn()
    const waiting = waitForHostGeneratedBrowserPublication({
      isMaterialized: () => materialized,
      refresh,
      canRetry: () => true,
      shouldRetryError: () => false
    })

    materialized = true
    await vi.advanceTimersByTimeAsync(40)

    await expect(waiting).resolves.toBe(true)
    expect(refresh).not.toHaveBeenCalled()
  })

  it('stops when the pairing owner changes', async () => {
    vi.useFakeTimers()
    const refresh = vi.fn()
    const waiting = waitForHostGeneratedBrowserPublication({
      isMaterialized: () => false,
      refresh,
      canRetry: () => false,
      shouldRetryError: () => false
    })

    await vi.advanceTimersByTimeAsync(40)

    await expect(waiting).resolves.toBe(false)
    expect(refresh).not.toHaveBeenCalled()
  })

  it('bounds stale inventory retries', async () => {
    vi.useFakeTimers()
    const refresh = vi.fn().mockResolvedValue(undefined)
    const waiting = waitForHostGeneratedBrowserPublication({
      isMaterialized: () => false,
      refresh,
      canRetry: () => true,
      shouldRetryError: () => false
    })

    await vi.advanceTimersByTimeAsync(1_600)

    await expect(waiting).resolves.toBe(false)
    expect(refresh).toHaveBeenCalledTimes(4)
  })

  it('continues after a transient inventory failure', async () => {
    vi.useFakeTimers()
    let materialized = false
    const refresh = vi
      .fn()
      .mockRejectedValueOnce(new Error('disconnected'))
      .mockImplementationOnce(() => {
        materialized = true
        return Promise.resolve()
      })
    const waiting = waitForHostGeneratedBrowserPublication({
      isMaterialized: () => materialized,
      refresh,
      canRetry: () => true,
      shouldRetryError: () => true
    })

    await vi.advanceTimersByTimeAsync(160)

    await expect(waiting).resolves.toBe(true)
    expect(refresh).toHaveBeenCalledTimes(2)
  })
})
