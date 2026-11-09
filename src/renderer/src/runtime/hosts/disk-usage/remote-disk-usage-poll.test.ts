import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DISK_USAGE_MAX_BACKOFF_MS,
  DISK_USAGE_POLL_MS,
  isDiskUsageUnsupportedError,
  nextDiskUsageDelayMs,
  readCachedDiskUsage,
  resetDiskUsagePollStateForTests,
  startDiskUsagePoll
} from './remote-disk-usage-poll'
import { RuntimeRpcCallError } from '../../rpc/calls/runtime-rpc-result'
import type { OrcadDiskUsageResult } from '../../../../../shared/orcad-disk-usage'

const RESULT: OrcadDiskUsageResult = {
  checkedAt: 1,
  volumes: [{ path: '/', totalBytes: 10, freeBytes: 1, availableBytes: 1, usedPercent: 90 }]
}

function rpcError(code: string): RuntimeRpcCallError {
  return new RuntimeRpcCallError({
    id: '1',
    ok: false,
    error: { code, message: code },
    _meta: { runtimeId: 'r' }
  } as never)
}

function noFocus(): () => void {
  return () => {}
}

beforeEach(() => {
  vi.useFakeTimers()
  resetDiskUsagePollStateForTests()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('nextDiskUsageDelayMs', () => {
  it('polls every minute and backs off exponentially to a ceiling', () => {
    expect(nextDiskUsageDelayMs(0)).toBe(DISK_USAGE_POLL_MS)
    expect(nextDiskUsageDelayMs(1)).toBe(2 * DISK_USAGE_POLL_MS)
    expect(nextDiskUsageDelayMs(2)).toBe(4 * DISK_USAGE_POLL_MS)
    expect(nextDiskUsageDelayMs(20)).toBe(DISK_USAGE_MAX_BACKOFF_MS)
  })
})

describe('isDiskUsageUnsupportedError', () => {
  it('treats only method_not_found as unsupported; forbidden and others back off', () => {
    expect(isDiskUsageUnsupportedError(rpcError('method_not_found'))).toBe(true)
    expect(isDiskUsageUnsupportedError(rpcError('forbidden'))).toBe(false)
    expect(isDiskUsageUnsupportedError(rpcError('timeout'))).toBe(false)
    expect(isDiskUsageUnsupportedError(new Error('socket closed'))).toBe(false)
  })
})

describe('startDiskUsagePoll', () => {
  it('fetches immediately, then every minute, caching the reading', async () => {
    const fetch = vi.fn(async () => RESULT)
    const onResult = vi.fn()
    const stop = startDiskUsagePoll({
      environmentId: 'env',
      runtimeId: 'r1',
      onResult,
      fetch,
      subscribeFocus: noFocus
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(onResult).toHaveBeenLastCalledWith(RESULT)
    expect(readCachedDiskUsage('env')).toBe(RESULT)
    await vi.advanceTimersByTimeAsync(DISK_USAGE_POLL_MS)
    expect(fetch).toHaveBeenCalledTimes(2)
    stop()
    await vi.advanceTimersByTimeAsync(DISK_USAGE_POLL_MS * 5)
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('stops silently on method_not_found and skips that runtime afterwards', async () => {
    const fetch = vi.fn(async () => {
      throw rpcError('method_not_found')
    })
    const onResult = vi.fn()
    startDiskUsagePoll({
      environmentId: 'env',
      runtimeId: 'r1',
      onResult,
      fetch,
      subscribeFocus: noFocus
    })
    await vi.advanceTimersByTimeAsync(DISK_USAGE_POLL_MS * 10)
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(onResult).toHaveBeenCalledWith(null)

    startDiskUsagePoll({
      environmentId: 'env',
      runtimeId: 'r1',
      onResult,
      fetch,
      subscribeFocus: noFocus
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(fetch).toHaveBeenCalledTimes(1)

    // A re-imaged VM reports a new runtime id and may now ship the method.
    const stop = startDiskUsagePoll({
      environmentId: 'env',
      runtimeId: 'r2',
      onResult,
      fetch,
      subscribeFocus: noFocus
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(fetch).toHaveBeenCalledTimes(2)
    stop()
  })

  it('backs off on transient failures without reporting them', async () => {
    const fetch = vi
      .fn<() => Promise<OrcadDiskUsageResult>>()
      .mockRejectedValueOnce(new Error('timeout'))
      .mockResolvedValue(RESULT)
    const onResult = vi.fn()
    const stop = startDiskUsagePoll({
      environmentId: 'env',
      runtimeId: null,
      onResult,
      fetch,
      subscribeFocus: noFocus
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(onResult).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(DISK_USAGE_POLL_MS)
    expect(fetch).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(DISK_USAGE_POLL_MS)
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(onResult).toHaveBeenCalledWith(RESULT)
    stop()
  })

  it('refreshes on focus only after the minimum gap', async () => {
    const fetch = vi.fn(async () => RESULT)
    let focus = (): void => {}
    const stop = startDiskUsagePoll({
      environmentId: 'env',
      runtimeId: null,
      onResult: () => {},
      fetch,
      subscribeFocus: (onFocus) => {
        focus = onFocus
        return () => {}
      }
    })
    await vi.advanceTimersByTimeAsync(0)
    focus()
    await vi.advanceTimersByTimeAsync(0)
    expect(fetch).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(20_000)
    focus()
    await vi.advanceTimersByTimeAsync(0)
    expect(fetch).toHaveBeenCalledTimes(2)
    stop()
  })
})
