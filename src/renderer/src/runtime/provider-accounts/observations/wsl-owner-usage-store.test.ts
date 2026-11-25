// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type {
  ProviderRateLimits,
  RateLimitState
} from '../../../../../shared/agent-usage/rate-limits/rate-limit-types'
import { createEmptyRateLimitState } from '../../../../../shared/agent-usage/rate-limits/rate-limit-state-factory'
import {
  clearWslOwnerUsageReads,
  invalidateWslOwnerUsage,
  readWslOwnerUsage,
  refreshWslOwnerUsage,
  wslOwnerUsageRetryDelayMs
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

it('passes a pending Retry-After to the read and keeps the held provider’s reading', async () => {
  let codexPercent = 10
  readUsageForRuntimeTarget.mockImplementation(
    async (_target: unknown, holds?: { claudeRetryAtMs?: number }) =>
      createEmptyRateLimitState({
        claude: holds?.claudeRetryAtMs ? null : claude(Date.now() + 30 * 60 * 1000),
        codex: codex(codexPercent)
      })
  )
  await refreshWslOwnerUsage('Ubuntu')
  const firstRetryAt = readWslOwnerUsage('Ubuntu')?.rateLimits.claude?.usageMetadata?.retryAtMs
  expect(firstRetryAt ?? 0).toBeGreaterThan(Date.now())

  codexPercent = 20
  vi.advanceTimersByTime(61_000)
  await refreshWslOwnerUsage('Ubuntu', true)
  expect(readUsageForRuntimeTarget).toHaveBeenCalledTimes(2)
  expect(readUsageForRuntimeTarget.mock.calls[1][1]).toEqual({ claudeRetryAtMs: firstRetryAt })
  const cached = readWslOwnerUsage('Ubuntu')
  // Claude was held at the source (null) and keeps its 429 reading; Codex still refreshed.
  expect(cached?.rateLimits.claude?.usageMetadata?.retryAtMs).toBe(firstRetryAt)
  expect(cached?.rateLimits.codex?.session?.usedPercent).toBe(20)

  // A settled read still waits the poll cadence.
  clearWslOwnerUsageReads()
  readUsageForRuntimeTarget.mockReset()
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

it('retries a provider error on the short cadence even when retained windows are shown', async () => {
  readUsageForRuntimeTarget.mockResolvedValue(
    createEmptyRateLimitState({
      claude: { ...claude(), status: 'error', session: null, error: 'probe failed' }
    })
  )
  await refreshWslOwnerUsage('Ubuntu')
  expect(readWslOwnerUsage('Ubuntu')?.attemptFailed).toBe(true)
  vi.advanceTimersByTime(61_000)
  await refreshWslOwnerUsage('Ubuntu')
  expect(readUsageForRuntimeTarget).toHaveBeenCalledTimes(2)
})

it('drops only the switched provider’s reading when its account changes', async () => {
  readUsageForRuntimeTarget.mockResolvedValue(
    createEmptyRateLimitState({ claude: claude(), codex: codex(10) })
  )
  await refreshWslOwnerUsage('Ubuntu')

  invalidateWslOwnerUsage('Ubuntu', 'codex')
  const cached = readWslOwnerUsage('Ubuntu')
  expect(cached?.rateLimits.codex).toBeNull()
  // The unchanged provider's reading and backoff stay put.
  expect(cached?.rateLimits.claude?.session?.usedPercent).toBe(40)

  // The switched provider is read again even though the entry is fresh.
  await refreshWslOwnerUsage('Ubuntu', true)
  expect(readUsageForRuntimeTarget).toHaveBeenCalledTimes(2)
})

it('discards a read that started before an account switch', async () => {
  let settle: (state: RateLimitState) => void = () => {}
  readUsageForRuntimeTarget.mockReturnValueOnce(
    new Promise<RateLimitState>((resolve) => {
      settle = resolve
    })
  )
  const pending = refreshWslOwnerUsage('Ubuntu')
  invalidateWslOwnerUsage('Ubuntu', 'claude')
  settle(createEmptyRateLimitState({ claude: claude() }))
  await pending
  // The outgoing account's numbers never land under the new account.
  expect(readWslOwnerUsage('Ubuntu')).toBeNull()
})

it('exposes a retry delay only while a reading is abnormal', async () => {
  readUsageForRuntimeTarget.mockRejectedValue(new Error('probe failed'))
  await refreshWslOwnerUsage('Ubuntu')
  expect(wslOwnerUsageRetryDelayMs('Ubuntu')).toBe(60_000)

  readUsageForRuntimeTarget.mockResolvedValue(createEmptyRateLimitState({ claude: claude() }))
  await refreshWslOwnerUsage('Ubuntu', true)
  expect(wslOwnerUsageRetryDelayMs('Ubuntu')).toBeNull()
})
