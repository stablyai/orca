// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProviderRateLimits } from '../../../../../shared/agent-usage/rate-limits/rate-limit-types'

const mocks = vi.hoisted(() => {
  let resolveWrite: (() => void) | null = null
  return {
    consume: vi.fn(async () => {}),
    updateSettings: vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveWrite = resolve
        })
    ),
    finishWrite: () => resolveWrite?.()
  }
})

vi.mock('../../../store/index', () => {
  const state = {
    settings: { skipCodexRateLimitResetConfirm: false },
    updateSettings: mocks.updateSettings,
    consumeCodexRateLimitResetCredit: mocks.consume,
    rateLimits: { codexTarget: { runtime: 'host' } }
  }
  const useAppStore = (selector: (s: typeof state) => unknown) => selector(state)
  useAppStore.getState = () => state
  return { useAppStore }
})
vi.mock('@/runtime/provider-accounts/usage/runtime-codex-reset-credit-client', () => ({
  consumeHostCodexResetCredit: vi.fn(),
  hasUnansweredHostCodexReset: () => false,
  hostSupportsCodexResetCredit: async () => true
}))
vi.mock('@/i18n/use-translate', () => ({
  useTranslate: () => (_key: string, fallback: string) => fallback
}))

const { useCodexResetAction } = await import('./use-codex-reset-action')

function codex(availableCount: number): ProviderRateLimits {
  return {
    provider: 'codex',
    session: { usedPercent: 100, windowMinutes: 300, resetsAt: null, resetDescription: null },
    weekly: null,
    updatedAt: 1,
    error: null,
    status: 'ok',
    rateLimitResetCredits: { availableCount, nextExpiresAt: 2_000_000_000_000 }
  }
}

describe('useCodexResetAction', () => {
  beforeEach(() => {
    mocks.consume.mockClear()
    mocks.updateSettings.mockClear()
  })
  afterEach(cleanup)

  it('does not spend after a refresh empties the offer behind an open confirmation', async () => {
    const { result, rerender } = renderHook(
      ({ limits }) => useCodexResetAction(limits, null, null, true),
      { initialProps: { limits: codex(1) } }
    )
    act(() => result.current.handleResetMenuSelect())
    expect(result.current.resetConfirmOpen).toBe(true)

    rerender({ limits: codex(0) })
    expect(result.current.resetConfirmOpen).toBe(false)
    await act(() => result.current.handleConfirmReset())
    expect(mocks.consume).not.toHaveBeenCalled()
  })

  it('rechecks the offer after the preference write finishes', async () => {
    const { result, rerender } = renderHook(
      ({ limits }) => useCodexResetAction(limits, null, null, true),
      { initialProps: { limits: codex(1) } }
    )
    act(() => result.current.handleResetMenuSelect())
    act(() => result.current.setSkipFutureResetConfirm(true))
    let confirm: Promise<void> = Promise.resolve()
    act(() => {
      confirm = result.current.handleConfirmReset()
    })
    rerender({ limits: codex(0) })
    await act(async () => {
      mocks.finishWrite()
      await confirm
    })
    expect(mocks.updateSettings).toHaveBeenCalledOnce()
    expect(mocks.consume).not.toHaveBeenCalled()
  })

  it('still spends a confirmed reset while the offer is unchanged', async () => {
    const { result } = renderHook(() => useCodexResetAction(codex(1), null, null, true))
    act(() => result.current.handleResetMenuSelect())
    await act(() => result.current.handleConfirmReset())
    expect(mocks.consume).toHaveBeenCalledOnce()
  })
})
