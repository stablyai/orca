// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentSessionAccountUsage } from '../../../../shared/agent-session/agent-session-account-usage'
import NativeChatAccountUsageDialog from './NativeChatAccountUsageDialog'
import { openNativeChatAccountUsageModal } from './native-chat-account-usage-modal'

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
vi.mock('@/runtime/runtime-provider-accounts-client', () => ({
  watchProviderAccounts: (_target: unknown, handlers: { onSnapshot: (s: unknown) => void }) => {
    hostStream.snapshot = handlers.onSnapshot
    return {
      close: () => {
        hostStream.snapshot = null
      }
    }
  }
}))
vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: mocks.read
}))
vi.mock('@/runtime/runtime-rpc-client', () => ({ callRuntimeRpc: mocks.reset }))
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
const target = { kind: 'environment' as const, environmentId: 'paired-host' }
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
const hostState = (account: string, availableCount = 1, status = 'ok') => ({
  codex: { accounts: [], activeAccountId: account },
  rateLimits: {
    codexTarget: { runtime: 'host', wslDistro: null },
    codex: { status, rateLimitResetCredits: { availableCount, nextExpiresAt: 2_000 } }
  }
})
afterEach(() => {
  cleanup()
  vi.resetAllMocks()
})

describe('/usage modal', () => {
  it('opens for the chat it was typed in and closes from its Close button', async () => {
    mocks.read.mockResolvedValue(result)
    openNativeChatAccountUsageModal({ sessionId: 'chat', target })
    expect(mocks.openModal).toHaveBeenCalledWith('chat-account-usage', {
      sessionId: 'chat',
      target
    })
    render(<NativeChatAccountUsageDialog />)
    expect(screen.getByRole('dialog', { name: 'Codex usage' })).toBeTruthy()
    await screen.findByText('chat@example.com')
    expect(mocks.read).toHaveBeenCalledWith(target, 'agentSession.accountUsage', {
      sessionId: 'chat'
    })
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(mocks.closeModal).toHaveBeenCalled()
  })

  it('renders the chat account’s provider usage, retries the same confirmed reset on its host and reports its outcome', async () => {
    mocks.read.mockResolvedValue(result)
    mocks.reset
      .mockRejectedValueOnce(new Error('connection lost'))
      .mockResolvedValueOnce({ outcome: 'nothingToReset' })
    render(<NativeChatAccountUsageDialog />)
    await screen.findByText('chat@example.com')
    expect(screen.getByText('100% used')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Reset now' }))
    await screen.findByRole('button', { name: 'Retry' })
    const first = mocks.reset.mock.calls[0]?.[2]
    expect(first).toEqual({
      idempotencyKey: expect.any(String),
      expectedScope: result.reset?.expectedScope
    })
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(mocks.reset).toHaveBeenCalledTimes(2))
    expect(mocks.reset.mock.calls[1]).toEqual([target, 'accounts.consumeCodexResetCredit', first])
    await waitFor(() => expect(mocks.read).toHaveBeenCalledTimes(2))
    await screen.findByText('Nothing to reset right now.')
  })

  it('keeps the reset outcome when the refresh after it fails, through Retry', async () => {
    mocks.read
      .mockResolvedValueOnce(result)
      .mockRejectedValueOnce(new Error('connection lost'))
      .mockResolvedValueOnce(result)
    mocks.reset.mockResolvedValueOnce({ outcome: 'reset' })
    render(<NativeChatAccountUsageDialog />)
    await screen.findByText('chat@example.com')
    fireEvent.click(screen.getByRole('button', { name: 'Reset now' }))
    await screen.findByText('Codex usage couldn’t be loaded. Try again.')
    expect(screen.getByText('Codex limits were reset.')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await screen.findByText('chat@example.com')
    expect(screen.getByText('Codex limits were reset.')).toBeTruthy()
  })

  it('reads nothing when a reset confirmed before closing finishes after it', async () => {
    let finish!: (value: unknown) => void
    mocks.read.mockResolvedValue(result)
    mocks.reset.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    const view = render(<NativeChatAccountUsageDialog />)
    await screen.findByText('chat@example.com')
    fireEvent.click(screen.getByRole('button', { name: 'Reset now' }))
    view.unmount()
    await act(async () => finish({ outcome: 'reset' }))
    expect(mocks.read).toHaveBeenCalledOnce()
  })

  it('re-reads the offer when the host’s Codex state lands after the modal opened', async () => {
    const { reset: _offer, ...withoutOffer } = result
    mocks.read.mockResolvedValueOnce(withoutOffer).mockResolvedValueOnce(result)
    render(<NativeChatAccountUsageDialog />)
    await screen.findByText('chat@example.com')
    expect(screen.queryByRole('button', { name: 'Reset now' })).toBeNull()
    act(() => hostStream.snapshot?.(hostState('chat', 0, 'fetching')))
    expect(mocks.read).toHaveBeenCalledOnce()
    act(() => hostStream.snapshot?.(hostState('chat', 1)))
    await screen.findByRole('button', { name: 'Reset now' })
    expect(mocks.read).toHaveBeenCalledTimes(2)
    // An unchanged host state reads nothing more.
    act(() => hostStream.snapshot?.(hostState('chat', 1)))
    expect(mocks.read).toHaveBeenCalledTimes(2)
  })

  it('collapses host changes during a background read into one follow-up, and sends none after closing', async () => {
    const finishes: ((value: AgentSessionAccountUsage) => void)[] = []
    mocks.read.mockResolvedValueOnce(result).mockImplementation(
      () =>
        new Promise<AgentSessionAccountUsage>((resolve) => {
          finishes.push(resolve)
        })
    )
    const view = render(<NativeChatAccountUsageDialog />)
    await screen.findByText('chat@example.com')
    act(() => hostStream.snapshot?.(hostState('chat')))
    act(() => hostStream.snapshot?.(hostState('other')))
    act(() => hostStream.snapshot?.(hostState('other', 0)))
    act(() => hostStream.snapshot?.(hostState('chat', 0)))
    expect(mocks.read).toHaveBeenCalledTimes(2)
    await act(async () => finishes[0]?.(result))
    await waitFor(() => expect(mocks.read).toHaveBeenCalledTimes(3))
    expect(screen.getByText('chat@example.com')).toBeTruthy()
    act(() => hostStream.snapshot?.(hostState('other')))
    view.unmount()
    await act(async () => finishes[1]?.(result))
    expect(mocks.read).toHaveBeenCalledTimes(3)
  })
})
