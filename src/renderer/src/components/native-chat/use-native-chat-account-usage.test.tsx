// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentSessionAccountUsage } from '../../../../shared/agent-session/agent-session-account-usage'
import { useNativeChatAccountUsage } from './use-native-chat-account-usage'

const mocks = vi.hoisted(() => ({
  read: vi.fn(),
  reset: vi.fn(),
  updateSettings: vi.fn()
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
    updateSettings: mocks.updateSettings
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
function Chat({
  turnId = null,
  sessionId = 'chat',
  promptId = null
}: {
  turnId?: string | null
  sessionId?: string
  promptId?: string | null
}) {
  const usage = useNativeChatAccountUsage({
    supported: true,
    sessionId,
    target,
    fence: 1,
    turnId,
    promptId
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

  it('clears when a waiting approval is answered, and a reset finishing after the chat closes reads nothing', async () => {
    let finish!: (value: unknown) => void
    mocks.read.mockResolvedValue(result)
    mocks.reset.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    const view = render(<Chat promptId="approval-1" />)
    fireEvent.click(screen.getByText('Usage'))
    await screen.findByText('chat@example.com')
    view.rerender(<Chat promptId={null} />)
    expect(screen.queryByText('chat@example.com')).toBeNull()
    fireEvent.click(screen.getByText('Usage'))
    await screen.findByText('chat@example.com')
    fireEvent.click(screen.getByRole('button', { name: 'Reset now' }))
    view.unmount()
    await act(async () => finish({ outcome: 'reset' }))
    expect(mocks.read).toHaveBeenCalledTimes(2)
  })

  it('re-reads the offer when the host’s Codex state lands after the card opened, keeping the card', async () => {
    const { reset: _offer, ...withoutOffer } = result
    mocks.read.mockResolvedValueOnce(withoutOffer).mockResolvedValueOnce(result)
    render(<Chat />)
    fireEvent.click(screen.getByText('Usage'))
    await screen.findByText('chat@example.com')
    expect(screen.queryByRole('button', { name: 'Reset now' })).toBeNull()
    const host = (status: string, availableCount: number) => ({
      codex: { accounts: [], activeAccountId: 'chat' },
      rateLimits: {
        codexTarget: { runtime: 'host', wslDistro: null },
        codex: { status, rateLimitResetCredits: { availableCount, nextExpiresAt: 2_000 } }
      }
    })
    act(() => hostStream.snapshot?.(host('fetching', 0)))
    expect(mocks.read).toHaveBeenCalledOnce()
    act(() => hostStream.snapshot?.(host('ok', 1)))
    await screen.findByRole('button', { name: 'Reset now' })
    expect(mocks.read).toHaveBeenCalledTimes(2)
    // An unchanged host state reads nothing more.
    act(() => hostStream.snapshot?.(host('ok', 1)))
    expect(mocks.read).toHaveBeenCalledTimes(2)
  })

  it('collapses host changes during a background read into one follow-up read', async () => {
    let finish!: (value: AgentSessionAccountUsage) => void
    mocks.read
      .mockResolvedValueOnce(result)
      .mockImplementationOnce(
        () =>
          new Promise<AgentSessionAccountUsage>((resolve) => {
            finish = resolve
          })
      )
      .mockResolvedValue(result)
    render(<Chat />)
    fireEvent.click(screen.getByText('Usage'))
    await screen.findByText('chat@example.com')
    const host = (account: string, availableCount: number) => ({
      codex: { accounts: [], activeAccountId: account },
      rateLimits: {
        codexTarget: { runtime: 'host', wslDistro: null },
        codex: { status: 'ok', rateLimitResetCredits: { availableCount, nextExpiresAt: 2_000 } }
      }
    })
    act(() => hostStream.snapshot?.(host('chat', 1)))
    act(() => hostStream.snapshot?.(host('other', 1)))
    act(() => hostStream.snapshot?.(host('other', 0)))
    act(() => hostStream.snapshot?.(host('chat', 0)))
    expect(mocks.read).toHaveBeenCalledTimes(2)
    await act(async () => finish(result))
    await waitFor(() => expect(mocks.read).toHaveBeenCalledTimes(3))
    expect(screen.getByText('chat@example.com')).toBeTruthy()
  })

  it('retires a queued background re-read with its card, so another chat keeps its own usage', async () => {
    let finish!: (value: AgentSessionAccountUsage) => void
    const other: AgentSessionAccountUsage = {
      ...result,
      account: { kind: 'managed', email: 'other@example.com' }
    }
    mocks.read
      .mockResolvedValueOnce(result)
      .mockImplementationOnce(
        () =>
          new Promise<AgentSessionAccountUsage>((resolve) => {
            finish = resolve
          })
      )
      .mockResolvedValueOnce(other)
    const host = (account: string) => ({
      codex: { accounts: [], activeAccountId: account },
      rateLimits: {
        codexTarget: { runtime: 'host', wslDistro: null },
        codex: { status: 'ok', rateLimitResetCredits: { availableCount: 1, nextExpiresAt: 2_000 } }
      }
    })
    const view = render(<Chat />)
    fireEvent.click(screen.getByText('Usage'))
    await screen.findByText('chat@example.com')
    act(() => hostStream.snapshot?.(host('chat')))
    act(() => hostStream.snapshot?.(host('other')))
    act(() => hostStream.snapshot?.(host('chat')))
    expect(mocks.read).toHaveBeenCalledTimes(2)
    view.rerender(<Chat sessionId="other" />)
    fireEvent.click(screen.getByText('Usage'))
    await screen.findByText('other@example.com')
    await act(async () => finish(result))
    expect(mocks.read).toHaveBeenCalledTimes(3)
    expect(mocks.read.mock.calls[2]?.[2]).toEqual({ sessionId: 'other' })
    expect(screen.getByText('other@example.com')).toBeTruthy()
  })

  it.each(['dismiss', 'unmount'] as const)(
    'sends no queued background re-read after the card is retired by %s',
    async (retire) => {
      let finish!: (value: AgentSessionAccountUsage) => void
      mocks.read.mockResolvedValueOnce(result).mockImplementationOnce(
        () =>
          new Promise<AgentSessionAccountUsage>((resolve) => {
            finish = resolve
          })
      )
      const host = (account: string) => ({
        codex: { accounts: [], activeAccountId: account },
        rateLimits: {
          codexTarget: { runtime: 'host', wslDistro: null },
          codex: {
            status: 'ok',
            rateLimitResetCredits: { availableCount: 1, nextExpiresAt: 2_000 }
          }
        }
      })
      const view = render(<Chat />)
      fireEvent.click(screen.getByText('Usage'))
      await screen.findByText('chat@example.com')
      act(() => hostStream.snapshot?.(host('chat')))
      act(() => hostStream.snapshot?.(host('other')))
      act(() => hostStream.snapshot?.(host('chat')))
      expect(mocks.read).toHaveBeenCalledTimes(2)
      if (retire === 'dismiss') {
        fireEvent.click(screen.getByRole('button', { name: 'Dismiss Codex usage' }))
      } else {
        view.unmount()
      }
      await act(async () => finish(result))
      expect(mocks.read).toHaveBeenCalledTimes(2)
    }
  )

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
