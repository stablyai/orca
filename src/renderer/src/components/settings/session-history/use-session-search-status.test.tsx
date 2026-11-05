// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { unavailableSessionSearchStatus } from '../../../../../shared/ai-vault/search/ai-vault-search-client'
import type { AiVaultSearchStatus } from '../../../../../shared/ai-vault/search/ai-vault-search-types'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../../shared/execution-host'

import { useSessionSearchStatus } from './use-session-search-status'

const mocks = vi.hoisted(() => ({ visible: true, status: vi.fn() }))
vi.mock('@/hooks/use-window-stream-visibility', () => ({
  useWindowStreamVisible: () => mocks.visible
}))
vi.mock('@/i18n/i18n', () => ({
  getIntlLocale: () => 'en',
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
