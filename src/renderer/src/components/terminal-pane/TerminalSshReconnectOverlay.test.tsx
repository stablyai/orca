// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { TerminalSshReconnectOverlay } from './TerminalSshReconnectOverlay'
import { useAppStore } from '@/store'
import { resetSshConnectInFlightForTests } from '@/ssh/ssh-connect-in-flight'
import type { SshConnectionState } from '../../../../shared/ssh-types'

const toastMocks = vi.hoisted(() => ({
  error: vi.fn()
}))

const deleteFlowMocks = vi.hoisted(() => ({
  runWorktreeDelete: vi.fn()
}))

const environmentSshMocks = vi.hoisted(() => ({
  connectRuntimeEnvironmentSshTarget: vi.fn(),
  resyncRuntimeEnvironmentSshTargets: vi.fn()
}))

vi.mock('sonner', () => ({
  toast: {
    error: toastMocks.error
  }
}))

vi.mock('../sidebar/delete-worktree-flow', () => ({
  runWorktreeDelete: deleteFlowMocks.runWorktreeDelete
}))

vi.mock('@/runtime/runtime-environment-ssh-state', () => environmentSshMocks)

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, values?: Record<string, string>) =>
    fallback.replace('{{value0}}', values?.value0 ?? '')
}))

function installSshConnect(
  connect: ReturnType<typeof vi.fn>,
  overrides: Record<string, ReturnType<typeof vi.fn>> = {}
): void {
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      ssh: {
        connect,
        listTargets: vi.fn().mockResolvedValue([]),
        listRemovedTargetLabels: vi.fn().mockResolvedValue({}),
        ...overrides
      }
    }
  })
}

describe('TerminalSshReconnectOverlay', () => {
  beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState(), true)
    resetSshConnectInFlightForTests()
    toastMocks.error.mockReset()
    deleteFlowMocks.runWorktreeDelete.mockReset()
    environmentSshMocks.connectRuntimeEnvironmentSshTarget.mockReset()
    environmentSshMocks.resyncRuntimeEnvironmentSshTargets.mockReset()
  })

  afterEach(() => {
    cleanup()
  })

  it('renders a non-blocking Connect banner for a disconnected SSH terminal', async () => {
    const connect = vi.fn().mockResolvedValue(undefined)
    installSshConnect(connect)
    const user = userEvent.setup()

    const { container } = render(
      <TerminalSshReconnectOverlay
        targetId="ssh-target-1"
        targetLabel="devbox"
        status="disconnected"
      />
    )

    expect(screen.getByText('SSH connection required')).toBeInTheDocument()
    expect(screen.getByText(/This terminal is waiting for devbox/)).toBeInTheDocument()
    expect(screen.getByRole('status')).toBeInTheDocument()
    const banner = container.querySelector('[data-terminal-ssh-reconnect-banner="disconnected"]')
    expect(banner).toHaveClass('inset-x-3', 'bottom-3', 'z-40')
    expect(banner).not.toHaveClass('inset-0', 'bg-background/75')
    await user.click(screen.getByRole('button', { name: 'Connect' }))

    expect(connect).toHaveBeenCalledWith({ targetId: 'ssh-target-1' })
  })

  // The canned "Connect again to continue" sentence is the same for a timeout and for a refused
  // host key. Only the detail says which, and for a host key it carries the only remedy the user
  // will see anywhere in the terminal.
  it('shows the failure detail beneath the status sentence', () => {
    installSshConnect(vi.fn())

    render(
      <TerminalSshReconnectOverlay
        targetId="ssh-target-1"
        targetLabel="devbox"
        status="error"
        error="Host key verification failed for devbox. Run: ssh-keygen -R devbox"
      />
    )

    // Both, not either: the sentence says what to do, the detail says what happened.
    expect(screen.getByText(/The SSH connection to devbox failed/)).toBeInTheDocument()
    expect(screen.getByText(/ssh-keygen -R devbox/)).toBeInTheDocument()
  })

  it('shows nothing extra when there is no detail', () => {
    installSshConnect(vi.fn())

    render(
      <TerminalSshReconnectOverlay targetId="ssh-target-1" targetLabel="devbox" status="error" />
    )

    expect(screen.getByText(/The SSH connection to devbox failed/)).toBeInTheDocument()
    expect(screen.queryByText(/ssh-keygen/)).not.toBeInTheDocument()
  })

  // A removed target already explains itself and can never reconnect; a stale connection error
  // underneath would contradict that.
  it('suppresses the detail for a removed target', () => {
    installSshConnect(vi.fn())

    render(
      <TerminalSshReconnectOverlay
        targetId="ssh-target-1"
        targetLabel="devbox"
        status="error"
        error="Host key verification failed for devbox."
        targetRemoved
      />
    )

    expect(screen.queryByText(/Host key verification failed/)).not.toBeInTheDocument()
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
    expect(screen.getByRole('button', { name: /Connecting…/ })).toBeDisabled()
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

    await user.click(screen.getByRole('button', { name: 'Reconnect' }))

    await waitFor(() => expect(toastMocks.error).toHaveBeenCalledWith('Passphrase rejected'))
    expect(screen.getByRole('button', { name: 'Reconnect' })).toBeEnabled()
  })

  it('resyncs target metadata after a failed connect so a stale overlay converges', async () => {
    const connect = vi.fn().mockRejectedValue(new Error('SSH target "ssh-dead" not found'))
    const listTargets = vi
      .fn()
      .mockResolvedValue([
        { id: 'ssh-live', label: 'devbox', host: 'devbox', port: 22, username: 'me' }
      ])
    const listRemovedTargetLabels = vi.fn().mockResolvedValue({ 'ssh-dead': 'devbox (removed)' })
    installSshConnect(connect, { listTargets, listRemovedTargetLabels })
    const user = userEvent.setup()

    render(
      <TerminalSshReconnectOverlay targetId="ssh-dead" targetLabel="devbox" status="disconnected" />
    )

    await user.click(screen.getByRole('button', { name: 'Connect' }))

    // Why: the metadata refresh is what flips TerminalPane's targetRemoved
    // derivation, replacing the failing Connect loop with the ghost-host UI.
    await waitFor(() => {
      expect(useAppStore.getState().sshTargetLabels.get('ssh-live')).toBe('devbox')
      expect(useAppStore.getState().removedSshTargetLabels.get('ssh-dead')).toBe('devbox (removed)')
    })
  })

  it('still applies the target list when the removed-labels refresh fails', async () => {
    const connect = vi.fn().mockRejectedValue(new Error('SSH target "ssh-dead" not found'))
    const listTargets = vi
      .fn()
      .mockResolvedValue([
        { id: 'ssh-live', label: 'devbox', host: 'devbox', port: 22, username: 'me' }
      ])
    const listRemovedTargetLabels = vi.fn().mockRejectedValue(new Error('unavailable'))
    installSshConnect(connect, { listTargets, listRemovedTargetLabels })
    const user = userEvent.setup()

    render(
      <TerminalSshReconnectOverlay targetId="ssh-dead" targetLabel="devbox" status="disconnected" />
    )

    await user.click(screen.getByRole('button', { name: 'Connect' }))

    // Why: a removed-labels failure must not discard the refreshed target
    // list — it alone is enough evidence for targetRemoved to converge.
    await waitFor(() => {
      expect(useAppStore.getState().sshTargetLabels.get('ssh-live')).toBe('devbox')
      expect(useAppStore.getState().sshTargetsHydrated).toBe(true)
    })
  })

  it('offers to remove the workspace (not Connect) when the SSH target was removed', async () => {
    const connect = vi.fn().mockResolvedValue(undefined)
    installSshConnect(connect)
    const user = userEvent.setup()

    render(
      <TerminalSshReconnectOverlay
        targetId="ssh-dead"
        targetLabel="ssh-dead"
        status="disconnected"
        targetRemoved
        worktreeId="repo::/work/wt"
      />
    )

    expect(screen.getByText('SSH host removed')).toBeInTheDocument()
    // No Connect button — reconnect is impossible for a removed target.
    expect(screen.queryByRole('button', { name: 'Connect' })).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Remove workspace' }))
    expect(deleteFlowMocks.runWorktreeDelete).toHaveBeenCalledWith('repo::/work/wt', {
      expectedHostId: 'ssh:ssh-dead'
    })
    expect(connect).not.toHaveBeenCalled()
  })

  it('routes Connect to the owning environment runtime RPC for a remote-owned workspace', async () => {
    const connect = vi.fn().mockResolvedValue(undefined)
    installSshConnect(connect)
    environmentSshMocks.connectRuntimeEnvironmentSshTarget.mockResolvedValue(null)
    const user = userEvent.setup()

    render(
      <TerminalSshReconnectOverlay
        targetId="ssh-remote-1"
        targetLabel="devbox"
        status="disconnected"
        sshOwnerEnvironmentId="env-1"
      />
    )

    await user.click(screen.getByRole('button', { name: 'Connect' }))

    await waitFor(() =>
      expect(environmentSshMocks.connectRuntimeEnvironmentSshTarget).toHaveBeenCalledWith(
        'env-1',
        'ssh-remote-1'
      )
    )
    // The local ssh API must never see a remote host's target.
    expect(connect).not.toHaveBeenCalled()
  })

  it('resyncs the owning environment (not the local store) after a failed remote connect', async () => {
    const connect = vi.fn().mockResolvedValue(undefined)
    const listTargets = vi.fn().mockResolvedValue([])
    installSshConnect(connect, { listTargets })
    environmentSshMocks.connectRuntimeEnvironmentSshTarget.mockRejectedValue(
      new Error('SSH target "ssh-remote-dead" not found')
    )
    environmentSshMocks.resyncRuntimeEnvironmentSshTargets.mockResolvedValue(undefined)
    const user = userEvent.setup()

    render(
      <TerminalSshReconnectOverlay
        targetId="ssh-remote-dead"
        targetLabel="devbox"
        status="disconnected"
        sshOwnerEnvironmentId="env-1"
      />
    )

    await user.click(screen.getByRole('button', { name: 'Connect' }))

    await waitFor(() =>
      expect(toastMocks.error).toHaveBeenCalledWith('SSH target "ssh-remote-dead" not found')
    )
    await waitFor(() =>
      expect(environmentSshMocks.resyncRuntimeEnvironmentSshTargets).toHaveBeenCalledWith('env-1')
    )
    // The failed-connect resync must not rewrite local target metadata.
    expect(listTargets).not.toHaveBeenCalled()
    expect(useAppStore.getState().sshTargetsHydrated).toBe(false)
  })

  // Why: the sidebar card control, the host-header menu, and this overlay can be on screen
  // at once; a shared verb table keeps them from naming the same click three ways.
  it.each([
    ['disconnected', 'Connect'],
    ['auth-failed', 'Reconnect'],
    ['error', 'Retry'],
    ['reconnection-failed', 'Retry']
  ] as const)('labels the %s action %s, matching every other SSH surface', (status, verb) => {
    installSshConnect(vi.fn().mockResolvedValue(undefined))

    render(
      <TerminalSshReconnectOverlay targetId="ssh-target-1" targetLabel="devbox" status={status} />
    )

    expect(screen.getByRole('button', { name: verb })).toBeEnabled()
  })

  it('suppresses a second connect while one is already in flight for the same target', async () => {
    const connect = vi.fn().mockReturnValue(new Promise(() => {}))
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

    // Why: N surfaces share one connection; a second dial on a passphrase-gated
    // target means a second credential prompt.
    await waitFor(() => expect(screen.getByRole('button', { name: /Connecting…/ })).toBeDisabled())
    expect(connect).toHaveBeenCalledTimes(1)
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
