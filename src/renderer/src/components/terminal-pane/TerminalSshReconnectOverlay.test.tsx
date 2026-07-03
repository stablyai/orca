// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { TerminalSshReconnectOverlay } from './TerminalSshReconnectOverlay'
import { useAppStore } from '@/store'
import type { SshConnectionState } from '../../../../shared/ssh-types'

const toastMocks = vi.hoisted(() => ({
  error: vi.fn()
}))

vi.mock('sonner', () => ({
  toast: {
    error: toastMocks.error
  }
}))

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, values?: Record<string, string>) =>
    fallback.replace('{{value0}}', values?.value0 ?? '')
}))

function installSshConnect(connect: ReturnType<typeof vi.fn>): void {
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      ssh: {
        connect
      }
    }
  })
}

describe('TerminalSshReconnectOverlay', () => {
  beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState(), true)
    toastMocks.error.mockReset()
  })

  afterEach(() => {
    cleanup()
  })

  it('renders a direct Connect action for a disconnected SSH terminal', async () => {
    const connect = vi.fn().mockResolvedValue(undefined)
    installSshConnect(connect)
    const user = userEvent.setup()

    render(
      <TerminalSshReconnectOverlay
        targetId="ssh-target-1"
        targetLabel="devbox"
        status="disconnected"
      />
    )

    expect(screen.getByText('SSH connection required')).toBeInTheDocument()
    expect(screen.getByText(/This terminal is waiting for devbox/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Connect' }))

    expect(connect).toHaveBeenCalledWith({ targetId: 'ssh-target-1' })
  })

  it('shows an in-flight state while the SSH target is reconnecting', () => {
    const connect = vi.fn().mockResolvedValue(undefined)
    installSshConnect(connect)

    render(
      <TerminalSshReconnectOverlay
        targetId="ssh-target-1"
        targetLabel="devbox"
        status="reconnecting"
      />
    )

    expect(screen.getByText(/Connecting to devbox/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Connecting.../ })).toBeDisabled()
    expect(connect).not.toHaveBeenCalled()
  })

  it('reports connect failures and re-enables the Connect action', async () => {
    const connect = vi.fn().mockRejectedValue(new Error('Passphrase rejected'))
    installSshConnect(connect)
    const user = userEvent.setup()

    render(
      <TerminalSshReconnectOverlay
        targetId="ssh-target-1"
        targetLabel="devbox"
        status="auth-failed"
      />
    )

    await user.click(screen.getByRole('button', { name: 'Connect' }))

    await waitFor(() => expect(toastMocks.error).toHaveBeenCalledWith('Passphrase rejected'))
    expect(screen.getByRole('button', { name: 'Connect' })).toBeEnabled()
  })

  it('publishes the returned SSH state so deferred terminal reattach can resume', async () => {
    const connectedState: SshConnectionState = {
      targetId: 'ssh-target-1',
      status: 'connected',
      error: null,
      reconnectAttempt: 0,
      remotePlatform: 'linux'
    }
    const connect = vi.fn().mockResolvedValue(connectedState)
    installSshConnect(connect)
    const user = userEvent.setup()

    render(
      <TerminalSshReconnectOverlay
        targetId="ssh-target-1"
        targetLabel="devbox"
        status="disconnected"
      />
    )

    await user.click(screen.getByRole('button', { name: 'Connect' }))

    await waitFor(() =>
      expect(useAppStore.getState().sshConnectionStates.get('ssh-target-1')).toEqual(connectedState)
    )
  })
})
