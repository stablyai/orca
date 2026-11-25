// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProviderRateLimits } from '../../../../../../shared/agent-usage/rate-limits/rate-limit-types'
import { createEmptyRateLimitState } from '../../../../../../shared/agent-usage/rate-limits/rate-limit-state-factory'

const mocks = vi.hoisted(() => ({
  storeState: { recordFeatureInteraction: vi.fn(), rateLimits: { commandCode: null } },
  callCommandCodeCredentials: vi.fn()
}))

vi.mock('@/store/index', () => ({
  useAppStore: (selector: (state: unknown) => unknown) => selector(mocks.storeState)
}))

vi.mock('@/runtime/provider-accounts/usage/runtime-usage-credentials-client', () => ({
  callCommandCodeCredentials: (...args: unknown[]) => mocks.callCommandCodeCredentials(...args),
  UsageCredentialsHostOutdatedError: class UsageCredentialsHostOutdatedError extends Error {}
}))

import {
  selectCommandCodeUsage,
  useCommandCodeCredentials,
  type OwnerUsageSnapshot
} from './CommandCodeAccountsSection'

function provider(): ProviderRateLimits {
  return {
    provider: 'command-code',
    session: null,
    weekly: null,
    updatedAt: 1,
    error: null,
    status: 'ok'
  }
}

function snapshot(
  environmentId: string,
  commandCode: ProviderRateLimits | null
): OwnerUsageSnapshot {
  return { environmentId, rateLimits: createEmptyRateLimitState({ commandCode }) }
}

describe('selectCommandCodeUsage', () => {
  it("uses this computer's poll for local scope", () => {
    const local = provider()
    expect(
      selectCommandCodeUsage(
        { owner: { kind: 'local' }, label: null },
        local,
        snapshot('e1', provider())
      )
    ).toBe(local)
  })

  it('uses the owner reading for a remote host, never null', () => {
    const owner = provider()
    expect(
      selectCommandCodeUsage(
        { owner: { kind: 'environment', environmentId: 'e1' }, label: 'server' },
        provider(),
        snapshot('e1', owner)
      )
    ).toBe(owner)
  })

  it('ignores a snapshot streamed for a different host', () => {
    expect(
      selectCommandCodeUsage(
        { owner: { kind: 'environment', environmentId: 'e1' }, label: 'server' },
        provider(),
        snapshot('other', provider())
      )
    ).toBeNull()
  })
})

describe('useCommandCodeCredentials retry', () => {
  beforeEach(() => {
    mocks.callCommandCodeCredentials.mockReset()
  })
  afterEach(cleanup)

  it('re-runs getStatus after a remote unreachable failure', async () => {
    mocks.callCommandCodeCredentials.mockRejectedValueOnce(new Error('unreachable'))
    const owner = { kind: 'environment', environmentId: 'env-1' } as const
    const { result } = renderHook(() => useCommandCodeCredentials(undefined, owner))
    await act(async () => {})
    expect(result.current.access).toBe('unreachable')

    mocks.callCommandCodeCredentials.mockResolvedValueOnce({ apiKeyConfigured: true })
    await act(async () => {
      result.current.retry()
    })
    expect(result.current.access).toBe('ready')
    expect(result.current.status).toEqual({ apiKeyConfigured: true })
    expect(mocks.callCommandCodeCredentials).toHaveBeenCalledTimes(2)
  })
})
