// @vitest-environment happy-dom

import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createEmptyRateLimitState } from '../../../../shared/rate-limit-state-factory'
import type { RateLimitState } from '../../../../shared/rate-limit-types'
import { useActiveRuntimeRateLimits } from './use-active-runtime-rate-limits'

const mocks = vi.hoisted(() => ({
  close: vi.fn(),
  refreshRemoteProviderAccountsSnapshot: vi.fn(),
  watcherHandlers: null as {
    onSnapshot: (snapshot: { rateLimits: RateLimitState | null }) => void
    onError: (error: unknown) => void
  } | null
}))

vi.mock('../../runtime/runtime-provider-accounts-client', () => ({
  hasRemoteProviderAccountOwner: (settings: { activeRuntimeEnvironmentId?: string | null }) =>
    Boolean(settings?.activeRuntimeEnvironmentId?.trim()),
  watchProviderAccounts: (_settings: unknown, handlers: typeof mocks.watcherHandlers) => {
    mocks.watcherHandlers = handlers
    return { close: mocks.close }
  },
  refreshRemoteProviderAccountsSnapshot: mocks.refreshRemoteProviderAccountsSnapshot
}))

function provider(provider: 'codex' | 'grok') {
  return {
    provider,
    session: { usedPercent: 25, windowMinutes: 300, resetsAt: null, resetDescription: null },
    weekly: null,
    updatedAt: 1,
    error: null,
    status: 'ok' as const
  }
}

beforeEach(() => {
  mocks.close.mockReset()
  mocks.refreshRemoteProviderAccountsSnapshot.mockReset()
  mocks.watcherHandlers = null
})

describe('useActiveRuntimeRateLimits', () => {
  it('never presents local usage as the selected remote host and follows streamed snapshots', () => {
    const local = createEmptyRateLimitState({ codex: provider('codex') })
    const remote = createEmptyRateLimitState({ grok: provider('grok') })
    const view = renderHook(
      ({ environmentId }) =>
        useActiveRuntimeRateLimits(local, { activeRuntimeEnvironmentId: environmentId }),
      { initialProps: { environmentId: 'one' as string | null } }
    )

    expect(view.result.current.remoteOwner).toBe(true)
    expect(view.result.current.rateLimits.codex).toBeNull()

    act(() => mocks.watcherHandlers?.onSnapshot({ rateLimits: remote }))
    expect(view.result.current.rateLimits.grok?.provider).toBe('grok')

    view.rerender({ environmentId: null })
    expect(mocks.close).toHaveBeenCalledTimes(1)
    expect(view.result.current.remoteOwner).toBe(false)
    expect(view.result.current.rateLimits.codex?.provider).toBe('codex')
  })

  it('applies the forced remote refresh result to the visible owner', async () => {
    const remote = createEmptyRateLimitState({ grok: provider('grok') })
    mocks.refreshRemoteProviderAccountsSnapshot.mockResolvedValue({ rateLimits: remote })
    const view = renderHook(() =>
      useActiveRuntimeRateLimits(createEmptyRateLimitState(), {
        activeRuntimeEnvironmentId: 'one'
      })
    )

    await act(() => view.result.current.refreshRemoteRateLimits())

    expect(mocks.refreshRemoteProviderAccountsSnapshot).toHaveBeenCalledTimes(1)
    expect(view.result.current.rateLimits.grok?.provider).toBe('grok')
  })
})
