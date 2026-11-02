// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CalmRemoteRuntimeReconnectBanner,
  TerminalRemoteRuntimeReconnectBanner
} from './TerminalRemoteRuntimeReconnectBanner'
import {
  CALM_STATUS_MIN_VISIBLE_MS,
  CALM_STATUS_REVEAL_DELAY_MS
} from '../../../../shared/calm-status-reveal'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, options?: Record<string, string>) =>
    fallback.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => options?.[name] ?? ''),
  getIntlLocale: () => 'en-US'
}))

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: unknown) => unknown) =>
    selector({
      settings: {},
      runtimeEnvironments: [
        {
          id: 'env-1',
          name: 'Desk',
          preferredEndpointId: 'ws',
          endpoints: [{ id: 'ws', endpoint: 'ws://100.101.102.103:6768' }]
        }
      ]
    })
}))

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('TerminalRemoteRuntimeReconnectBanner', () => {
  it('names the server and the cause while retrying, without a manual action', () => {
    render(
      <TerminalRemoteRuntimeReconnectBanner
        recovery={{ phase: 'backoff', cause: 'stream-stalled' }}
        serverName="Desk"
        onReconnect={vi.fn()}
      />
    )

    expect(screen.getByText('Terminal stopped responding')).toBeInTheDocument()
    expect(screen.getByText(/Desk stopped sending/)).toBeInTheDocument()
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })

  it('stays neutral when nothing shows the connection dropped, such as a capacity refusal', () => {
    render(
      <TerminalRemoteRuntimeReconnectBanner
        recovery={{ phase: 'backoff' }}
        serverName="Desk"
        tailscaleHost="100.101.102.103"
        onReconnect={vi.fn()}
      />
    )

    expect(screen.getByText('Reattaching terminal')).toBeInTheDocument()
    expect(screen.queryByText(/connection to the server dropped/)).not.toBeInTheDocument()
    expect(screen.queryByText(/tailscale ping/)).not.toBeInTheDocument()
  })

  it('never claims a parked pane is retrying, and offers to try now', async () => {
    const onReconnect = vi.fn()
    const user = userEvent.setup()
    render(
      <TerminalRemoteRuntimeReconnectBanner
        recovery={{ phase: 'recovering', cause: 'stream-ended', waiting: true }}
        serverName="Desk"
        onReconnect={onReconnect}
      />
    )

    expect(screen.getByText('Waiting for Desk')).toBeInTheDocument()
    expect(screen.queryByText(/retrying/i)).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Reconnect' }))
    expect(onReconnect).toHaveBeenCalledOnce()
  })

  it('offers one explicit reconnect action after automatic recovery stops', async () => {
    const onReconnect = vi.fn()
    const user = userEvent.setup()
    render(
      <TerminalRemoteRuntimeReconnectBanner
        recovery={{ phase: 'disconnected' }}
        serverName="Desk"
        onReconnect={onReconnect}
      />
    )

    expect(screen.getByText('Remote runtime disconnected')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Reconnect' }))
    expect(onReconnect).toHaveBeenCalledOnce()
  })

  it('says the host refused this computer instead of spinning, even mid-recovery', () => {
    render(
      <TerminalRemoteRuntimeReconnectBanner
        recovery={{ phase: 'backoff' }}
        serverName="Desk"
        onReconnect={vi.fn()}
        pairingRefused
      />
    )

    expect(screen.getByText('This host no longer accepts this computer')).toBeInTheDocument()
    expect(screen.queryByText('Reconnecting to Desk')).not.toBeInTheDocument()
  })
})

describe('SSH sign-in wait', () => {
  it.each(['backoff', 'disconnected'] as const)(
    'shows the sign-in wait at once during %s, never the runtime-lost copy',
    async (phase) => {
      const onReconnect = vi.fn()
      const user = userEvent.setup()
      render(
        <CalmRemoteRuntimeReconnectBanner
          recovery={{ phase }}
          environmentId="env-1"
          heldByServer={false}
          onReconnect={onReconnect}
          awaitingSignIn
        />
      )

      expect(screen.getByText('Waiting for SSH sign-in')).toBeInTheDocument()
      expect(screen.queryByText(/Remote runtime disconnected|Reconnecting/)).not.toBeInTheDocument()
      await user.click(screen.getByRole('button', { name: 'Sign in' }))
      expect(onReconnect).toHaveBeenCalledOnce()
    }
  )
})

describe('CalmRemoteRuntimeReconnectBanner', () => {
  it('drops a resolved sign-in card at once instead of holding stale copy', () => {
    vi.useFakeTimers()
    const props = { environmentId: 'env-1', heldByServer: false, onReconnect: vi.fn() }
    const { rerender } = render(
      <CalmRemoteRuntimeReconnectBanner
        {...props}
        recovery={{ phase: 'disconnected' }}
        awaitingSignIn
      />
    )
    expect(screen.getByText('Waiting for SSH sign-in')).toBeInTheDocument()

    rerender(<CalmRemoteRuntimeReconnectBanner {...props} recovery={null} />)

    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  it('stays quiet through a reconnect a 400 ms relay finishes, then says it with a Tailscale hint', () => {
    vi.useFakeTimers()
    const { rerender } = render(
      <CalmRemoteRuntimeReconnectBanner
        recovery={{ phase: 'backoff', cause: 'connection' }}
        environmentId="env-1"
        heldByServer={false}
        onReconnect={vi.fn()}
      />
    )
    act(() => vi.advanceTimersByTime(CALM_STATUS_REVEAL_DELAY_MS - 1))
    rerender(
      <CalmRemoteRuntimeReconnectBanner
        recovery={{ phase: 'recovering', cause: 'connection' }}
        environmentId="env-1"
        heldByServer={false}
        onReconnect={vi.fn()}
      />
    )
    expect(screen.queryByRole('status')).not.toBeInTheDocument()

    act(() => vi.advanceTimersByTime(1))
    expect(screen.getByText('Reconnecting to Desk')).toBeInTheDocument()
    expect(screen.getByText('tailscale ping 100.101.102.103')).toBeInTheDocument()
  })

  it('shows a stopped recovery at once', () => {
    vi.useFakeTimers()
    render(
      <CalmRemoteRuntimeReconnectBanner
        recovery={{ phase: 'disconnected' }}
        environmentId="env-1"
        heldByServer={false}
        onReconnect={vi.fn()}
      />
    )
    expect(screen.getByText('Remote runtime disconnected')).toBeInTheDocument()
  })

  it('keeps a manual Reconnect from hiding the banner it was clicked on', () => {
    vi.useFakeTimers()
    const { rerender } = render(
      <CalmRemoteRuntimeReconnectBanner
        recovery={{ phase: 'disconnected' }}
        environmentId="env-1"
        heldByServer={false}
        onReconnect={vi.fn()}
      />
    )
    rerender(
      <CalmRemoteRuntimeReconnectBanner
        recovery={{ phase: 'recovering', cause: 'connection' }}
        environmentId="env-1"
        heldByServer={false}
        onReconnect={vi.fn()}
      />
    )
    expect(screen.getByText('Reconnecting to Desk')).toBeInTheDocument()
  })

  it('holds a banner that just appeared long enough to read, then lets it go', () => {
    vi.useFakeTimers()
    const props = { environmentId: 'env-1', heldByServer: false, onReconnect: vi.fn() }
    const { rerender } = render(
      <CalmRemoteRuntimeReconnectBanner {...props} recovery={{ phase: 'backoff' }} />
    )
    act(() => vi.advanceTimersByTime(CALM_STATUS_REVEAL_DELAY_MS + 100))
    rerender(<CalmRemoteRuntimeReconnectBanner {...props} recovery={null} />)
    expect(screen.getByRole('status')).toBeInTheDocument()

    act(() => vi.advanceTimersByTime(CALM_STATUS_MIN_VISIBLE_MS))
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  it('leaves a server-wide drop to the server notice', () => {
    vi.useFakeTimers()
    render(
      <CalmRemoteRuntimeReconnectBanner
        recovery={{ phase: 'disconnected' }}
        environmentId="env-1"
        heldByServer
        onReconnect={vi.fn()}
      />
    )
    act(() => vi.advanceTimersByTime(CALM_STATUS_REVEAL_DELAY_MS * 2))
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  it('speaks at once for a pane still down when the server notice ends', () => {
    vi.useFakeTimers()
    const props = { environmentId: 'env-1', onReconnect: vi.fn() }
    const recovery = { phase: 'backoff' as const, cause: 'stream-stalled' as const }
    const { rerender } = render(
      <CalmRemoteRuntimeReconnectBanner {...props} recovery={recovery} heldByServer />
    )
    act(() => vi.advanceTimersByTime(CALM_STATUS_REVEAL_DELAY_MS * 2))
    rerender(
      <CalmRemoteRuntimeReconnectBanner {...props} recovery={recovery} heldByServer={false} />
    )
    expect(screen.getByText('Terminal stopped responding')).toBeInTheDocument()
  })
})
