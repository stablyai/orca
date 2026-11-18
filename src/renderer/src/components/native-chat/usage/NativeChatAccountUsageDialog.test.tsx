// @vitest-environment happy-dom
import { act, cleanup, render, screen } from '@testing-library/react'
import { StrictMode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentSessionAccountUsage } from '../../../../../shared/agent-session/lifecycle/accounts/agent-session-account-usage'
import NativeChatAccountUsageDialog from './NativeChatAccountUsageDialog'

const mocks = vi.hoisted(() => ({
  read: vi.fn(),
  reset: vi.fn(),
  updateSettings: vi.fn(),
  openModal: vi.fn(),
  closeModal: vi.fn()
}))
const hostStream = vi.hoisted(() => {
  const stream: { snapshot: ((snapshot: unknown) => void) | null } = { snapshot: null }
  return stream
})
vi.mock('@/runtime/provider-accounts/observations/runtime-provider-accounts-client', () => ({
  watchProviderAccounts: (_target: unknown, handlers: { onSnapshot: (s: unknown) => void }) => {
    hostStream.snapshot = handlers.onSnapshot
    return {
      close: () => {
        hostStream.snapshot = null
      }
    }
  }
}))
vi.mock('../../../runtime/native-chat/requests/structured-agent-session-call', () => ({
  callStructuredAgentSession: mocks.read
}))
vi.mock('@/runtime/rpc/calls/runtime-rpc-call', () => ({
  callRuntimeRpc: mocks.reset
}))
vi.mock('@/store', () => {
  const state = {
    usagePercentageDisplay: 'used',
    settings: { skipCodexRateLimitResetConfirm: true },
    updateSettings: mocks.updateSettings,
    modalData: { sessionId: 'chat', target: { kind: 'environment', environmentId: 'paired-host' } },
    openModal: mocks.openModal,
    closeModal: mocks.closeModal
  }
  const useAppStore = Object.assign(
    (selector: (value: typeof state) => unknown) => selector(state),
    { getState: () => state }
  )
  return { useAppStore }
})
const result: Extract<AgentSessionAccountUsage, { status: 'ok' }> = {
  status: 'ok',
  account: { kind: 'managed', email: 'chat@example.com' },
  rateLimits: {
    provider: 'codex',
    session: { usedPercent: 100, windowMinutes: 300, resetsAt: 1_000, resetDescription: 'soon' },
    weekly: null,
    rateLimitResetCredits: {
      availableCount: 1,
      totalEarnedCount: 1,
      nextExpiresAt: 2_000,
      credits: [{ status: 'available', expiresAt: 2_000, grantedAt: 500 }]
    },
    updatedAt: 30,
    error: null,
    status: 'ok'
  },
  reset: {
    available: 1,
    expectedScope: {
      target: { runtime: 'host', wslDistro: null },
      accountId: 'chat',
      accountRevision: 1,
      offerRevision: 'host-snapshot'
    }
  }
}
afterEach(() => {
  cleanup()
  vi.resetAllMocks()
})

describe('/usage modal', () => {
  it('keeps the newer first read when a replayed mount’s older read fails late', async () => {
    let failFirst!: (error: Error) => void
    mocks.read
      .mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) => {
            failFirst = reject
          })
      )
      .mockResolvedValueOnce(result)
    render(
      <StrictMode>
        <NativeChatAccountUsageDialog />
      </StrictMode>
    )
    await screen.findByText('chat@example.com')
    await act(async () => failFirst(new Error('connection lost')))
    expect(screen.getByText('chat@example.com')).toBeTruthy()
  })
})
