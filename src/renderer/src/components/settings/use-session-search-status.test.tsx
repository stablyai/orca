// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { unavailableSessionSearchStatus } from '../../../../shared/ai-vault-search-client'
import type { AiVaultSearchStatus } from '../../../../shared/ai-vault-search-types'
import { LOCAL_EXECUTION_HOST_ID, type ExecutionHostId } from '../../../../shared/execution-host'
import {
  sessionSearchStatusDetails,
  sessionSearchStatusMessage
} from './session-history-status-copy'
import { useSessionSearchStatus } from './use-session-search-status'

const mocks = vi.hoisted(() => ({ visible: true, status: vi.fn() }))
vi.mock('@/hooks/use-window-stream-visibility', () => ({
  useWindowStreamVisible: () => mocks.visible
}))
vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, args?: Record<string, unknown>) =>
    fallback.replace(/{{(\w+)}}/g, (_, key: string) => String(args?.[key]))
}))

const current: AiVaultSearchStatus = {
  ...unavailableSessionSearchStatus(),
  enabled: true,
  phase: 'current',
  filesIndexed: 12,
  messagesIndexed: 3_400,
  lastSweepCompletedAt: 1
}
function poll(active = true, refresh = 0) {
  return renderHook(
    (props: { active: boolean; refresh: number }) =>
      useSessionSearchStatus({
        executionHostId: LOCAL_EXECUTION_HOST_ID,
        active: props.active,
        refresh: props.refresh
      }),
    { initialProps: { active, refresh } }
  )
}
function message(status: AiVaultSearchStatus | null): string {
  return status ? sessionSearchStatusMessage(status) : 'no status read yet'
}
beforeEach(() => {
  vi.useFakeTimers()
  mocks.visible = true
  mocks.status.mockReset().mockResolvedValue(current)
  vi.stubGlobal('api', undefined)
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { aiVault: { searchStatus: mocks.status } }
  })
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

it('keeps polling a settled index so counts stay live between sweeps', async () => {
  const view = poll()
  await act(async () => {})
  expect(mocks.status).toHaveBeenCalledWith('local')
  expect(message(view.result.current.status)).toBe('12 sessions · 3.4K messages searchable')
  mocks.status.mockResolvedValue({ ...current, filesIndexed: 30, messagesIndexed: 9_000 })
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10_000)
  })
  expect(message(view.result.current.status)).toBe('30 sessions · 9K messages searchable')
})

it('counts a sweep in flight against what it knows about so far', async () => {
  mocks.status.mockResolvedValue({
    ...current,
    phase: 'indexing',
    filesIndexed: 4,
    filesDue: 6,
    messagesIndexed: 410_000,
    lastSweepCompletedAt: null
  })
  const view = poll()
  await act(async () => {})
  expect(message(view.result.current.status)).toBe('4 of 10 sessions · 410K messages searchable')
  expect(sessionSearchStatusDetails(view.result.current.status)).toEqual([])
  mocks.status.mockResolvedValue({
    ...current,
    phase: 'indexing',
    filesIndexed: 4,
    filesDue: 5,
    filesFailed: 1,
    messagesIndexed: 420_000,
    lastSweepCompletedAt: 1
  })
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2_000)
  })
  expect(message(view.result.current.status)).toBe('4 of 10 sessions · 420K messages searchable')
})

it('degrades to a session count when the host is too old to report messages', async () => {
  const { messagesIndexed: _messagesIndexed, ...withoutMessages } = current
  mocks.status.mockResolvedValue(withoutMessages)
  const view = poll()
  await act(async () => {})
  expect(message(view.result.current.status)).toBe('12 sessions searchable')
  mocks.status.mockResolvedValue({
    ...withoutMessages,
    phase: 'indexing',
    filesIndexed: 4,
    filesDue: 6
  })
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10_000)
  })
  expect(message(view.result.current.status)).toBe('4 of 10 sessions searchable')
})

it('polls a sweep faster than a settled index', async () => {
  mocks.status.mockResolvedValue({ ...current, phase: 'indexing', filesDue: 3 })
  poll()
  await act(async () => {})
  const started = mocks.status.mock.calls.length
  await act(async () => {
    await vi.advanceTimersByTimeAsync(6_000)
  })
  expect(mocks.status.mock.calls.length - started).toBe(3)
})

it('names unreadable files while degraded and still counts what is searchable', async () => {
  mocks.status.mockResolvedValue({
    ...current,
    phase: 'degraded',
    filesIndexed: 8,
    filesDue: 1,
    filesFailed: 1,
    degradedRoots: [{ reason: 'unreadable' }]
  })
  const view = poll()
  await act(async () => {})
  expect(message(view.result.current.status)).toBe('8 of 10 sessions · 3.4K messages searchable')
  expect(sessionSearchStatusDetails(view.result.current.status)).toEqual([
    '1 sessions could not be read and will be retried.',
    '1 session folders could not be checked.'
  ])
})

it('calls a drained degraded index up to date', async () => {
  mocks.status.mockResolvedValue({
    ...current,
    phase: 'degraded',
    filesIndexed: 9,
    filesDue: 0,
    filesFailed: 2
  })
  const view = poll()
  await act(async () => {})
  expect(message(view.result.current.status)).toBe('9 sessions · 3.4K messages searchable')
  expect(sessionSearchStatusDetails(view.result.current.status)).toEqual([
    '2 sessions could not be read and will be retried.'
  ])
})

it('does not describe an absent service as an empty current index', async () => {
  mocks.status.mockResolvedValue(unavailableSessionSearchStatus())
  const view = poll()
  await act(async () => {})
  expect(message(view.result.current.status)).toBe(
    'Search is not available on this computer right now.'
  )
})

it('recovers on its own after a failed read', async () => {
  mocks.status.mockRejectedValueOnce(new Error('offline'))
  const view = poll()
  await act(async () => {})
  expect(view.result.current.failed).toBe(true)
  expect(view.result.current.status).toBeNull()
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10_000)
  })
  expect(view.result.current.failed).toBe(false)
  expect(view.result.current.status).toEqual(current)
})

it('handles a synchronous bridge failure without losing the poll', async () => {
  mocks.status.mockImplementationOnce(() => {
    throw new Error('bridge unavailable')
  })
  const view = poll()
  await act(async () => {})
  expect(view.result.current.failed).toBe(true)
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10_000)
  })
  expect(view.result.current.status).toEqual(current)
})

it('stops polling while inactive or hidden and re-reads on a refresh bump', async () => {
  mocks.visible = false
  const view = poll()
  await act(async () => {
    await vi.advanceTimersByTimeAsync(60_000)
  })
  expect(mocks.status).not.toHaveBeenCalled()
  mocks.visible = true
  view.rerender({ active: false, refresh: 0 })
  await act(async () => {
    await vi.advanceTimersByTimeAsync(60_000)
  })
  expect(mocks.status).not.toHaveBeenCalled()
  view.rerender({ active: true, refresh: 1 })
  await act(async () => {})
  expect(mocks.status).toHaveBeenCalledTimes(1)
})

it('keeps the last answer when a host goes inactive so an offline row reports it', async () => {
  const view = poll()
  await act(async () => {})
  view.rerender({ active: false, refresh: 0 })
  expect(view.result.current.status).toEqual(current)
  expect(view.result.current.failed).toBe(false)
})

it('adopts a status handed to it without waiting for the next poll', async () => {
  const view = poll(false)
  act(() => {
    view.result.current.adopt({ ...current, filesIndexed: 99 })
  })
  expect(view.result.current.status?.filesIndexed).toBe(99)
  expect(mocks.status).not.toHaveBeenCalled()
})

it('does not overlap slow status requests and stops polling on unmount', async () => {
  let answer: (value: AiVaultSearchStatus) => void = () => undefined
  mocks.status.mockReturnValue(
    new Promise<AiVaultSearchStatus>((resolve) => {
      answer = resolve
    })
  )
  const view = poll()
  await act(async () => {
    await vi.advanceTimersByTimeAsync(30_000)
  })
  expect(mocks.status).toHaveBeenCalledTimes(1)
  await act(async () => {
    answer({ ...current, phase: 'indexing', filesDue: 2 })
  })
  const beforeUnmount = mocks.status.mock.calls.length
  view.unmount()
  await act(async () => {
    await vi.advanceTimersByTimeAsync(60_000)
  })
  expect(mocks.status).toHaveBeenCalledTimes(beforeUnmount)
})

it('marks the host too old on a host-too-old rejection and stops polling', async () => {
  mocks.status.mockRejectedValue(new Error('Error invoking remote method: host-too-old'))
  const { result } = poll()
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0)
  })
  expect(result.current.hostTooOld).toBe(true)
  expect(result.current.failed).toBe(true)
  const calls = mocks.status.mock.calls.length
  await act(async () => {
    await vi.advanceTimersByTimeAsync(30_000)
  })
  expect(mocks.status.mock.calls.length).toBe(calls)
})

it("drops one host's answer when pointed at another, even while inactive", async () => {
  const initialProps: { host: ExecutionHostId; active: boolean } = { host: 'ssh:a', active: true }
  const view = renderHook(
    (props: { host: ExecutionHostId; active: boolean }) =>
      useSessionSearchStatus({ executionHostId: props.host, active: props.active }),
    { initialProps }
  )
  await act(async () => {})
  expect(view.result.current.status).toEqual(current)
  view.rerender({ host: 'ssh:b', active: false })
  expect(view.result.current.status).toBeNull()
  expect(mocks.status).toHaveBeenCalledTimes(1)
})
