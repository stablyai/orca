// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type {
  ProviderRateLimits,
  RateLimitState
} from '../../../../../shared/agent-usage/rate-limits/rate-limit-types'
import { createEmptyRateLimitState } from '../../../../../shared/agent-usage/rate-limits/rate-limit-state-factory'
import {
  clearWslOwnerUsageReads,
  readWslOwnerUsage,
  refreshWslOwnerUsage
} from './wsl-owner-usage-store'

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

function codex(usedPercent: number): ProviderRateLimits {
  return {
    provider: 'codex',
    session: { usedPercent, windowMinutes: 300, resetsAt: null, resetDescription: null },
    weekly: null,
    updatedAt: 1,
    error: null,
    status: 'ok'
  }
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

it('spaces retries from the last failed attempt, not the last good read', async () => {
  readUsageForRuntimeTarget.mockRejectedValue(new Error('probe failed'))
  await refreshWslOwnerUsage('Ubuntu')
  vi.advanceTimersByTime(61_000)
  await refreshWslOwnerUsage('Ubuntu')
  expect(readUsageForRuntimeTarget).toHaveBeenCalledTimes(2)

  vi.advanceTimersByTime(1_000)
  await refreshWslOwnerUsage('Ubuntu')
  expect(readUsageForRuntimeTarget).toHaveBeenCalledTimes(2)
  vi.advanceTimersByTime(60_000)
  await refreshWslOwnerUsage('Ubuntu')
  expect(readUsageForRuntimeTarget).toHaveBeenCalledTimes(3)
})

it('keeps a provider’s last good windows when its new reading errors, taking the other fresh', async () => {
  readUsageForRuntimeTarget.mockResolvedValueOnce(
    createEmptyRateLimitState({ claude: claude(), codex: codex(10) })
  )
  await refreshWslOwnerUsage('Ubuntu')

  readUsageForRuntimeTarget.mockResolvedValueOnce(
    createEmptyRateLimitState({ claude: claude(), codex: codex(20) })
  )
  await refreshWslOwnerUsage('Ubuntu', true)
  expect(readWslOwnerUsage('Ubuntu')?.rateLimits.codex?.session?.usedPercent).toBe(20)

  readUsageForRuntimeTarget.mockResolvedValueOnce(
    createEmptyRateLimitState({
      claude: { ...claude(), status: 'error', session: null, error: 'rate limited' },
      codex: codex(30)
    })
  )
  await refreshWslOwnerUsage('Ubuntu', true)
  const cached = readWslOwnerUsage('Ubuntu')
  expect(cached?.rateLimits.claude?.status).toBe('ok')
  expect(cached?.rateLimits.claude?.session?.usedPercent).toBe(40)
  expect(cached?.rateLimits.codex?.session?.usedPercent).toBe(30)
  expect(cached?.failed).toBe(false)
})

it('does not let a read that started before a forced refresh satisfy it', async () => {
  let settleFirst: (state: RateLimitState) => void = () => {}
  readUsageForRuntimeTarget.mockReturnValueOnce(
    new Promise<RateLimitState>((resolve) => {
      settleFirst = resolve
    })
  )
  readUsageForRuntimeTarget.mockResolvedValue(createEmptyRateLimitState({ claude: claude() }))

  const first = refreshWslOwnerUsage('Ubuntu')
  const forced = refreshWslOwnerUsage('Ubuntu', true)
  expect(readUsageForRuntimeTarget).toHaveBeenCalledTimes(1)
  settleFirst(createEmptyRateLimitState({ claude: claude() }))
  await Promise.all([first, forced])
  expect(readUsageForRuntimeTarget).toHaveBeenCalledTimes(2)
})
