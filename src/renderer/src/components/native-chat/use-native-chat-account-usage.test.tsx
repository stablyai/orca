// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentSessionAccountUsage } from '../../../../shared/agent-session/agent-session-account-usage'
import { useNativeChatAccountUsage } from './use-native-chat-account-usage'

const mocks = vi.hoisted(() => ({ read: vi.fn(), reset: vi.fn(), updateSettings: vi.fn() }))
vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: mocks.read
}))
vi.mock('@/runtime/runtime-rpc-client', () => ({ callRuntimeRpc: mocks.reset }))
vi.mock('@/store', () => {
  const state = {
    usagePercentageDisplay: 'used',
    settings: { skipCodexRateLimitResetConfirm: true },
    updateSettings: mocks.updateSettings
  }
  const useAppStore = Object.assign(
    (selector: (value: typeof state) => unknown) => selector(state),
    { getState: () => state }
  )
  return { useAppStore }
})
const target = { kind: 'environment' as const, environmentId: 'paired-host' }
const result: AgentSessionAccountUsage = {
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
function Chat({
  turnId = null,
  sessionId = 'chat'
}: {
  turnId?: string | null
  sessionId?: string
}) {
  const usage = useNativeChatAccountUsage({
    supported: true,
    sessionId,
    target,
    fence: 1,
    turnId
  })
  return (
    <>
      <button onClick={usage.command?.open}>Usage</button>
      {usage.card}
    </>
  )
}
afterEach(() => {
  cleanup()
  vi.resetAllMocks()
})

describe('chat usage card', () => {
  it('renders the chat account’s provider usage, retries the same confirmed reset on its host and reports its outcome', async () => {
    mocks.read.mockResolvedValue(result)
    mocks.reset
      .mockRejectedValueOnce(new Error('connection lost'))
      .mockResolvedValueOnce({ outcome: 'nothingToReset' })
    render(<Chat />)
    fireEvent.click(screen.getByText('Usage'))
    await screen.findByText('chat@example.com')
    expect(screen.getByText('100% used')).toBeTruthy()
    expect(mocks.read).toHaveBeenCalledWith(target, 'agentSession.accountUsage', {
      sessionId: 'chat'
    })
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
    render(<Chat />)
    fireEvent.click(screen.getByText('Usage'))
    await screen.findByText('chat@example.com')
    fireEvent.click(screen.getByRole('button', { name: 'Reset now' }))
    await screen.findByText('Codex usage couldn’t be loaded. Try again.')
    expect(screen.getByText('Codex limits were reset.')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await screen.findByText('chat@example.com')
    expect(screen.getByText('Codex limits were reset.')).toBeTruthy()
  })

  it('does not reopen a dismissed card when an already-confirmed reset completes', async () => {
    let finish!: (value: unknown) => void
    mocks.read.mockResolvedValue(result)
    mocks.reset.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    render(<Chat />)
    fireEvent.click(screen.getByText('Usage'))
    await screen.findByText('chat@example.com')
    fireEvent.click(screen.getByRole('button', { name: 'Reset now' }))
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss Codex usage' }))
    await act(async () => finish({ outcome: 'reset' }))
    expect(screen.queryByText('chat@example.com')).toBeNull()
    expect(mocks.read).toHaveBeenCalledTimes(1)
  })

  it('discards dismissed and changed-session responses and clears on the next turn', async () => {
    let resolve!: (value: AgentSessionAccountUsage) => void
    mocks.read.mockImplementation(
      () =>
        new Promise<AgentSessionAccountUsage>((done) => {
          resolve = done
        })
    )
    const view = render(<Chat />)
    fireEvent.click(screen.getByText('Usage'))
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss Codex usage' }))
    await act(async () => resolve(result))
    expect(screen.queryByText('chat@example.com')).toBeNull()
    fireEvent.click(screen.getByText('Usage'))
    view.rerender(<Chat sessionId="other" />)
    await act(async () => resolve(result))
    expect(screen.queryByText('chat@example.com')).toBeNull()
    mocks.read.mockResolvedValue(result)
    fireEvent.click(screen.getByText('Usage'))
    await screen.findByText('chat@example.com')
    view.rerender(<Chat sessionId="other" turnId="new-turn" />)
    expect(screen.queryByText('chat@example.com')).toBeNull()
  })
})
