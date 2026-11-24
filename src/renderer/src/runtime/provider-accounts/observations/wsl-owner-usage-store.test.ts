// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { ProviderRateLimits } from '../../../../../shared/agent-usage/rate-limits/rate-limit-types'
import { createEmptyRateLimitState } from '../../../../../shared/agent-usage/rate-limits/rate-limit-state-factory'
import { clearWslOwnerUsageReads, refreshWslOwnerUsage } from './wsl-owner-usage-store'

const readUsageForRuntimeTarget = vi.fn()

function claude(retryAtMs?: number): ProviderRateLimits {
  const reading: ProviderRateLimits = {
    provider: 'claude',
    session: { usedPercent: 40, windowMinutes: 300, resetsAt: null, resetDescription: null },
    weekly: null,
    updatedAt: 1,
    error: null,
    status: 'ok'
  }
  return retryAtMs === undefined
    ? reading
    : { ...reading, status: 'error', session: null, usageMetadata: { retryAtMs } }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(Date.parse('2026-11-25T12:00:00Z'))
  readUsageForRuntimeTarget.mockReset()
  clearWslOwnerUsageReads()
  Object.assign(window, { api: { rateLimits: { readUsageForRuntimeTarget } } })
})

afterEach(() => {
  vi.useRealTimers()
})

it('retries a read still inside its Retry-After window on the short cadence, a settled one on the long', async () => {
  readUsageForRuntimeTarget.mockResolvedValue(
    createEmptyRateLimitState({ claude: claude(Date.now() + 30 * 60 * 1000) })
  )
  await refreshWslOwnerUsage('Ubuntu')
  vi.advanceTimersByTime(61_000)
  await refreshWslOwnerUsage('Ubuntu')
  expect(readUsageForRuntimeTarget).toHaveBeenCalledTimes(2)

  clearWslOwnerUsageReads()
  readUsageForRuntimeTarget.mockClear()
  readUsageForRuntimeTarget.mockResolvedValue(createEmptyRateLimitState({ claude: claude() }))
  await refreshWslOwnerUsage('Ubuntu')
  vi.advanceTimersByTime(61_000)
  await refreshWslOwnerUsage('Ubuntu')
  expect(readUsageForRuntimeTarget).toHaveBeenCalledTimes(1)
})
