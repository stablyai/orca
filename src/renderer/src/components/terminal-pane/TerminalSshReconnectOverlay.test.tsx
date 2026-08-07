// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactElement } from 'react'
import { TerminalSshReconnectOverlay } from './TerminalSshReconnectOverlay'
import { TooltipProvider } from '@/components/ui/tooltip'
import { useAppStore } from '@/store'
import { resetSshConnectInFlightForTests } from '@/ssh/ssh-connect-in-flight'
import { recordSshStateArrival, forgetSshStatusTimeline } from '@/lib/ssh-status-timeline'
import { resetSshDiagnosticAppVersionForTests } from '@/lib/ssh-diagnostic-report'
import type { SshConnectionState, SshConnectionStatus } from '../../../../shared/ssh-types'

const toastMocks = vi.hoisted(() => ({
  error: vi.fn(),
  success: vi.fn()
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
    error: toastMocks.error,
    success: toastMocks.success
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

type DiagnosticsApiMocks = {
  writeClipboardText: ReturnType<typeof vi.fn>
  getDiagnosticsStatus: ReturnType<typeof vi.fn>
  getVersion: ReturnType<typeof vi.fn>
}

function installSshConnect(
  connect: ReturnType<typeof vi.fn>,
  overrides: Record<string, ReturnType<typeof vi.fn>> = {},
  diagnosticsOverrides: Partial<DiagnosticsApiMocks> = {}
): DiagnosticsApiMocks {
  const diagnostics: DiagnosticsApiMocks = {
    writeClipboardText:
      diagnosticsOverrides.writeClipboardText ?? vi.fn().mockResolvedValue(undefined),
    getDiagnosticsStatus:
      diagnosticsOverrides.getDiagnosticsStatus ??
      vi.fn().mockResolvedValue({
        localFileEnabled: true,
        bundleEnabled: true,
        traceFilePath: '/tmp/trace.jsonl',
        traceFamilySize: 1
      }),
    getVersion: diagnosticsOverrides.getVersion ?? vi.fn().mockResolvedValue('1.4.163')
  }
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      ssh: {
        connect,
        listTargets: vi.fn().mockResolvedValue([]),
        listRemovedTargetLabels: vi.fn().mockResolvedValue({}),
        ...overrides
      },
      ui: { writeClipboardText: diagnostics.writeClipboardText },
      diagnostics: { getStatus: diagnostics.getDiagnosticsStatus },
      updater: { getVersion: diagnostics.getVersion }
    }
  })
  return diagnostics
}

// Radix's Tooltip.Root needs a provider ancestor; the app supplies one at the
// App root, so every render here has to as well.
function renderOverlay(ui: ReactElement): ReturnType<typeof render> {
  return render(<TooltipProvider>{ui}</TooltipProvider>)
}

function parseCopiedReport(text: string): {
  live: { status: string | null; targetRemoved: boolean; runtimeOwned: boolean }
  timeline: { status: string; attempt: number | null }[]
} {
  const fenced = /```json\n([\s\S]+?)\n```/.exec(text)
  if (!fenced?.[1]) {
    throw new Error(`copied report has no JSON fence: ${text}`)
  }
  return JSON.parse(fenced[1])
}

function connectionState(overrides: Partial<SshConnectionState> = {}): SshConnectionState {
  return {
    targetId: 'ssh-target-1',
    status: 'connected',
    error: null,
    reconnectAttempt: 0,
    ...overrides
  }
}

describe('TerminalSshReconnectOverlay', () => {
  beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState(), true)
    resetSshConnectInFlightForTests()
    toastMocks.error.mockReset()
    toastMocks.success.mockReset()
    deleteFlowMocks.runWorktreeDelete.mockReset()
    environmentSshMocks.connectRuntimeEnvironmentSshTarget.mockReset()
    environmentSshMocks.resyncRuntimeEnvironmentSshTargets.mockReset()
    resetSshDiagnosticAppVersionForTests()
    forgetSshStatusTimeline('ssh-target-1')
    forgetSshStatusTimeline('ssh-dead')
  })

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
  })

  it('renders a non-blocking Connect banner for a disconnected SSH terminal', async () => {
    const connect = vi.fn().mockResolvedValue(undefined)
    installSshConnect(connect)
    const user = userEvent.setup()

    const { container } = renderOverlay(
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

  it('shows an in-flight state while the SSH target is reconnecting', () => {
    const connect = vi.fn().mockResolvedValue(undefined)
    installSshConnect(connect)

    renderOverlay(
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

    renderOverlay(
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

    renderOverlay(
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

    renderOverlay(
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

    renderOverlay(
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
    expect(deleteFlowMocks.runWorktreeDelete).toHaveBeenCalledWith('repo::/work/wt')
    expect(connect).not.toHaveBeenCalled()
  })

  it('routes Connect to the owning environment runtime RPC for a remote-owned workspace', async () => {
    const connect = vi.fn().mockResolvedValue(undefined)
    installSshConnect(connect)
    environmentSshMocks.connectRuntimeEnvironmentSshTarget.mockResolvedValue(null)
    const user = userEvent.setup()

    renderOverlay(
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

    renderOverlay(
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

    renderOverlay(
      <TerminalSshReconnectOverlay targetId="ssh-target-1" targetLabel="devbox" status={status} />
    )

    expect(screen.getByRole('button', { name: verb })).toBeEnabled()
  })

  it('suppresses a second connect while one is already in flight for the same target', async () => {
    const connect = vi.fn().mockReturnValue(new Promise(() => {}))
    installSshConnect(connect)
    const user = userEvent.setup()

    renderOverlay(
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

    renderOverlay(
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

  it('copies a diagnostic report through the renderer clipboard API', async () => {
    const diagnostics = installSshConnect(vi.fn())
    useAppStore
      .getState()
      .setSshConnectionState(
        'ssh-target-1',
        connectionState({ status: 'reconnection-failed', error: 'relay budget exhausted' })
      )
    const user = userEvent.setup()

    renderOverlay(
      <TerminalSshReconnectOverlay
        targetId="ssh-target-1"
        targetLabel="devbox"
        status="reconnection-failed"
      />
    )

    await user.click(screen.getByRole('button', { name: 'Copy diagnostics' }))

    await waitFor(() => expect(diagnostics.writeClipboardText).toHaveBeenCalledTimes(1))
    const copied = diagnostics.writeClipboardText.mock.calls[0][0] as string
    expect(copied).toContain('SSH diagnostics ')
    expect(parseCopiedReport(copied).live.status).toBe('reconnection-failed')
    // The report must never carry the host the user already knows they clicked.
    expect(copied).not.toContain('devbox')
    expect(toastMocks.success).toHaveBeenCalledWith('Diagnostics copied')
  })

  it('reports a failed clipboard write instead of claiming success', async () => {
    const diagnostics = installSshConnect(
      vi.fn(),
      {},
      { writeClipboardText: vi.fn().mockRejectedValue(new Error('clipboard unavailable')) }
    )
    const user = userEvent.setup()

    renderOverlay(
      <TerminalSshReconnectOverlay targetId="ssh-target-1" targetLabel="devbox" status="error" />
    )

    await user.click(screen.getByRole('button', { name: 'Copy diagnostics' }))

    await waitFor(() => expect(toastMocks.error).toHaveBeenCalledWith('Failed to copy diagnostics'))
    expect(diagnostics.writeClipboardText).toHaveBeenCalledTimes(1)
    expect(toastMocks.success).not.toHaveBeenCalled()
  })

  // A main process that stops answering is the state this report exists for, so
  // the consent read in front of the (synchronous) assembly has to be bounded —
  // an unsettled promise never reaches the catch, leaving the button inert.
  it('reports a copy failure when the consent read never settles', async () => {
    const diagnostics = installSshConnect(
      vi.fn(),
      {},
      { getDiagnosticsStatus: vi.fn().mockReturnValue(new Promise(() => {})) }
    )
    vi.useFakeTimers()

    renderOverlay(
      <TerminalSshReconnectOverlay targetId="ssh-target-1" targetLabel="devbox" status="error" />
    )

    // fireEvent, not userEvent: its pointer sequence waits on the timers this
    // case has to drive by hand.
    fireEvent.click(screen.getByRole('button', { name: 'Copy diagnostics' }))
    expect(toastMocks.error).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(3_000)

    expect(diagnostics.getDiagnosticsStatus).toHaveBeenCalledTimes(1)
    expect(toastMocks.error).toHaveBeenCalledWith('Failed to copy diagnostics')
    expect(diagnostics.writeClipboardText).not.toHaveBeenCalled()
  })

  // The clipboard lives in main, so a wedged main hangs the WRITE too. Bounding
  // only the consent read in front of it left the same inert button one step later.
  it('reports a copy failure when the clipboard write never settles', async () => {
    const diagnostics = installSshConnect(
      vi.fn(),
      {},
      { writeClipboardText: vi.fn().mockReturnValue(new Promise(() => {})) }
    )
    vi.useFakeTimers()

    renderOverlay(
      <TerminalSshReconnectOverlay targetId="ssh-target-1" targetLabel="devbox" status="error" />
    )

    fireEvent.click(screen.getByRole('button', { name: 'Copy diagnostics' }))
    await vi.advanceTimersByTimeAsync(3_000)

    expect(diagnostics.writeClipboardText).toHaveBeenCalledTimes(1)
    expect(toastMocks.error).toHaveBeenCalledWith('Failed to copy diagnostics')
    expect(toastMocks.success).not.toHaveBeenCalled()
  })

  // Impatient repeat clicks are expected precisely because the main process is
  // wedged; each used to arm its own round-trips and stack a toast per click.
  it('ignores repeat clicks while a copy is already in flight', async () => {
    const diagnostics = installSshConnect(
      vi.fn(),
      {},
      { writeClipboardText: vi.fn().mockReturnValue(new Promise(() => {})) }
    )
    vi.useFakeTimers()

    renderOverlay(
      <TerminalSshReconnectOverlay targetId="ssh-target-1" targetLabel="devbox" status="error" />
    )

    const button = screen.getByRole('button', { name: 'Copy diagnostics' })
    fireEvent.click(button)
    fireEvent.click(button)
    fireEvent.click(button)
    await vi.advanceTimersByTimeAsync(3_000)

    expect(diagnostics.getDiagnosticsStatus).toHaveBeenCalledTimes(1)
    expect(diagnostics.writeClipboardText).toHaveBeenCalledTimes(1)
    expect(toastMocks.error).toHaveBeenCalledTimes(1)
  })

  // Why each posture, not just the explicit opt-out: `ci` is resolved before
  // ORCA_DIAGNOSTICS_DISABLED and returns a single reason, and the web stub
  // reports no reason at all — matching one reason string lets both copy.
  it.each([
    ['the explicit opt-out', 'orca_diagnostics_disabled'],
    ['CI, which masks the explicit opt-out', 'ci'],
    ['a fully-off posture that reports no reason', undefined]
  ])('refuses to copy when diagnostics are off — %s', async (_label, disabledReason) => {
    const diagnostics = installSshConnect(
      vi.fn(),
      {},
      {
        getDiagnosticsStatus: vi.fn().mockResolvedValue({
          localFileEnabled: false,
          bundleEnabled: false,
          traceFilePath: '',
          traceFamilySize: 0,
          ...(disabledReason ? { disabledReason } : {})
        })
      }
    )
    const user = userEvent.setup()

    renderOverlay(
      <TerminalSshReconnectOverlay
        targetId="ssh-target-1"
        targetLabel="devbox"
        status="disconnected"
      />
    )

    // The button stays mounted when consent is off — §7 gates the click, not the mount.
    await user.click(screen.getByRole('button', { name: 'Copy diagnostics' }))

    await waitFor(() =>
      expect(toastMocks.error).toHaveBeenCalledWith('Diagnostics are disabled on this device.')
    )
    expect(diagnostics.writeClipboardText).not.toHaveBeenCalled()
    expect(toastMocks.success).not.toHaveBeenCalled()
  })

  // Why: DO_NOT_TRACK gates the network lane only, and the clipboard is not a
  // network sink — gating on it would take the button away from a user who
  // never asked for that.
  it('still copies under DO_NOT_TRACK, which leaves the local lane enabled', async () => {
    const diagnostics = installSshConnect(
      vi.fn(),
      {},
      {
        getDiagnosticsStatus: vi.fn().mockResolvedValue({
          localFileEnabled: true,
          bundleEnabled: false,
          traceFilePath: '/tmp/trace.jsonl',
          traceFamilySize: 1,
          disabledReason: 'do_not_track'
        })
      }
    )
    const user = userEvent.setup()

    renderOverlay(
      <TerminalSshReconnectOverlay
        targetId="ssh-target-1"
        targetLabel="devbox"
        status="disconnected"
      />
    )

    await user.click(screen.getByRole('button', { name: 'Copy diagnostics' }))

    await waitFor(() => expect(diagnostics.writeClipboardText).toHaveBeenCalledTimes(1))
    expect(toastMocks.error).not.toHaveBeenCalled()
  })

  // Why: the overlay is in the web bundle with no web guard, and the web stub
  // cannot reach the serving host's consent — so the copy is blocked there and
  // the toast has to say that rather than blame a device setting.
  // The web stub hardcodes consent off for every browser client, so the control
  // could only ever produce its own failure toast. Not rendering it beats
  // rendering a button whose single reachable outcome is an error.
  it('does not offer the copy control at all on a web client', () => {
    const webWindow = globalThis as { __ORCA_WEB_CLIENT__?: boolean }
    webWindow.__ORCA_WEB_CLIENT__ = true
    try {
      installSshConnect(vi.fn())

      renderOverlay(
        <TerminalSshReconnectOverlay
          targetId="ssh-target-1"
          targetLabel="devbox"
          status="disconnected"
        />
      )

      expect(screen.queryByRole('button', { name: 'Copy diagnostics' })).toBeNull()
    } finally {
      delete webWindow.__ORCA_WEB_CLIENT__
    }
  })

  it('still carries the pre-removal timeline once the SSH target is gone', async () => {
    const diagnostics = installSshConnect(vi.fn())
    recordSshStateArrival(
      'ssh-dead',
      connectionState({ targetId: 'ssh-dead' }),
      'initial-hydration'
    )
    recordSshStateArrival(
      'ssh-dead',
      connectionState({ targetId: 'ssh-dead', status: 'reconnecting', reconnectAttempt: 1 }),
      'push'
    )
    recordSshStateArrival(
      'ssh-dead',
      connectionState({
        targetId: 'ssh-dead',
        status: 'reconnection-failed',
        reconnectAttempt: 9,
        error: 'Relay channel lost. Reconnecting...'
      }),
      'push'
    )
    const user = userEvent.setup()

    renderOverlay(
      <TerminalSshReconnectOverlay
        targetId="ssh-dead"
        targetLabel="ssh-dead"
        status="disconnected"
        targetRemoved
        worktreeId="repo::/work/wt"
      />
    )

    await user.click(screen.getByRole('button', { name: 'Copy diagnostics' }))

    await waitFor(() => expect(diagnostics.writeClipboardText).toHaveBeenCalledTimes(1))
    const report = parseCopiedReport(diagnostics.writeClipboardText.mock.calls[0][0] as string)
    expect(report.live.targetRemoved).toBe(true)
    expect(report.timeline.map((entry) => entry.status)).toEqual([
      'connected',
      'reconnecting',
      'reconnection-failed'
    ])
    expect(report.timeline.map((entry) => entry.attempt)).toEqual([0, 1, 9])
  })

  // Scope: this guards the button's styling and the action row's arity — not
  // the row's rendered size. happy-dom has no layout engine, so no width or
  // height is measurable in this suite; the width cost of the button was
  // measured separately in a real browser.
  // Why it still matters: the overlay paints on every wake-from-sleep, so any
  // state-dependent emphasis would turn a self-healing blip into an alarm (§6.1).
  it('gives the copy button one recessive style and one action-row arity across every state', () => {
    const statuses: SshConnectionStatus[] = [
      'connecting',
      'deploying-relay',
      'reconnecting',
      'disconnected',
      'error',
      'auth-failed',
      'reconnection-failed'
    ]
    const cases = [
      ...statuses.map((status) => ({ status, targetRemoved: false })),
      { status: 'disconnected' as SshConnectionStatus, targetRemoved: true }
    ]
    const classLists = new Set<string>()
    const rowChildCounts = new Set<number>()

    for (const { status, targetRemoved } of cases) {
      installSshConnect(vi.fn())
      renderOverlay(
        <TerminalSshReconnectOverlay
          targetId="ssh-target-1"
          targetLabel="devbox"
          status={status}
          targetRemoved={targetRemoved}
          worktreeId="repo::/work/wt"
        />
      )

      const button = screen.getByRole('button', { name: 'Copy diagnostics' })
      expect(button).toHaveAttribute('data-variant', 'ghost')
      expect(button).toHaveAttribute('data-size', 'icon-sm')
      // Neither the `default` nor the `destructive` variant fill.
      expect(button.className).not.toContain('bg-primary')
      expect(button.className).not.toContain('bg-destructive')
      // Icon only: a text label would read as a peer of Connect.
      expect(button.textContent).toBe('')
      // `icon-sm` forces no svg size, so the row's own icon scale survives.
      expect(button.querySelector('svg')?.getAttribute('class')).toContain('size-3.5')
      classLists.add(button.className)
      rowChildCounts.add(screen.getByRole('status').children.length)
      cleanup()
    }

    // One className for all 8 states: the styling carries no state dependence.
    expect(classLists.size).toBe(1)
    // One arity for all 8 states: no state adds or drops an action-row child.
    expect(rowChildCounts.size).toBe(1)
  })

  // Why: the title is shrink-0, so once the copy button takes its 32px + gap out
  // of the message column the title outgrows that column below ~415px and its
  // bold glyphs paint over the button unless the row clips them.
  it('clips the title row so an overflowing title cannot paint over the copy button', () => {
    installSshConnect(vi.fn())

    renderOverlay(
      <TerminalSshReconnectOverlay targetId="ssh-target-1" targetLabel="devbox" status="error" />
    )

    const title = screen.getByText('SSH connection required')
    const titleRow = title.parentElement
    expect(titleRow).toHaveClass('overflow-hidden', 'min-w-0')
    // The variable-length host label absorbs the shrink first; the constant
    // title must not start truncating while the label still has room.
    expect(title).toHaveClass('shrink-0')
    expect(screen.getByText('devbox')).toHaveClass('truncate')
  })
})
