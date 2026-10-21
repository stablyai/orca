import { useEffect, useState } from 'react'
import { Loader2, ServerOff } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import type { PtyTransportRecoveryState } from './pty-transport-types'
import type { WslHostUnavailableReason } from './use-wsl-host-unavailable-reason'
import { WslHostUnavailableBanner } from './WslHostUnavailableBanner'
import { StoppedMachineBanner } from '@/components/machines/StoppedMachineBanner'
import type { MachineMatch } from '@/lib/machines/machine-host-match'

type VisibleRecoveryPhase = Extract<
  PtyTransportRecoveryState['phase'],
  'recovering' | 'backoff' | 'disconnected'
>

// Why: a resubscribe that lands on its first backoff step plus an SSH round trip is
// invisible to the user, so announcing it only flashes a banner.
export const REMOTE_RUNTIME_RECOVERY_BANNER_DELAY_MS = 1_000

/** Shows retrying recovery only once it outlasts the delay; anything needing action shows at once. */
export function useRemoteRuntimeRecoveryBannerRevealed(needsAction: boolean): boolean {
  const [revealed, setRevealed] = useState(needsAction)
  if (needsAction && !revealed) {
    setRevealed(true)
  }
  useEffect(() => {
    if (revealed) {
      return
    }
    const timer = window.setTimeout(
      () => setRevealed(true),
      REMOTE_RUNTIME_RECOVERY_BANNER_DELAY_MS
    )
    return () => window.clearTimeout(timer)
  }, [revealed])
  return revealed
}

export function TerminalRemoteRuntimeReconnectBanner({
  phase,
  onReconnect,
  wslHostUnavailable = null,
  pairingRefused = false,
  wakingMachineName = null,
  wakeFailure = null,
  stoppedMachine = null,
  machineWorktreeId
}: {
  phase: VisibleRecoveryPhase
  onReconnect: () => void
  /** The pane's WSL host cannot run: nothing is retrying, so say why instead. */
  wslHostUnavailable?: WslHostUnavailableReason | null
  /** The pane's managed server refuses this desktop and pairing again over SSH failed. */
  pairingRefused?: boolean
  /** The pane's machine is waking, which is why it reconnects; named so one place says so. */
  wakingMachineName?: string | null
  /** Why waking `wakingMachineName` failed; the button then retries the wake. */
  wakeFailure?: string | null
  /** The pane's machine sleeps or is archived, so nothing reconnects until it wakes. */
  stoppedMachine?: MachineMatch | null
  /** The pane's worktree, so Wake holds its terminals like opening it does. */
  machineWorktreeId?: string
}): React.JSX.Element {
  if (wslHostUnavailable) {
    return <WslHostUnavailableBanner reason={wslHostUnavailable} />
  }
  if (stoppedMachine && wakingMachineName === null) {
    return <StoppedMachineBanner match={stoppedMachine} worktreeId={machineWorktreeId} />
  }
  const retrying = phase !== 'disconnected' && !pairingRefused
  const waking = retrying && wakingMachineName !== null
  const wakeFailed = !retrying && wakingMachineName !== null && wakeFailure !== null

  return (
    <div
      className="pointer-events-none absolute inset-x-3 bottom-3 z-30 flex justify-center"
      data-terminal-remote-runtime-reconnect-banner={pairingRefused ? 'pairing-refused' : phase}
    >
      <div
        className="pointer-events-auto flex w-full max-w-xl items-center gap-3 rounded-md border border-border bg-card/95 px-3 py-3 text-card-foreground shadow-xs backdrop-blur-[1px]"
        role="status"
        aria-live="polite"
      >
        <div className="flex size-8 shrink-0 items-center justify-center rounded-md border border-border bg-muted text-muted-foreground">
          {retrying ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <ServerOff className="size-4" />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold">
            {pairingRefused
              ? translate(
                  'auto.components.terminal.pane.TerminalRemoteRuntimeReconnectBanner.pairingRefusedTitle',
                  'This host no longer accepts this computer'
                )
              : wakeFailed
                ? translate(
                    'auto.lib.machines.machineWakeOnOpen.wakeFailed',
                    'Couldn’t wake {{name}}',
                    {
                      name: wakingMachineName
                    }
                  )
                : waking
                  ? translate(
                      'auto.components.terminal.pane.TerminalRemoteRuntimeReconnectBanner.wakingTitle',
                      'Waking {{name}}…',
                      { name: wakingMachineName }
                    )
                  : retrying
                    ? translate(
                        'auto.components.terminal.pane.TerminalRemoteRuntimeReconnectBanner.retryingTitle',
                        'Reconnecting to remote runtime'
                      )
                    : translate(
                        'auto.components.terminal.pane.TerminalRemoteRuntimeReconnectBanner.disconnectedTitle',
                        'Remote runtime disconnected'
                      )}
          </div>
          <div className="mt-0.5 text-xs leading-5 text-muted-foreground">
            {pairingRefused
              ? translate(
                  'auto.components.terminal.pane.TerminalRemoteRuntimeReconnectBanner.pairingRefusedBody',
                  "Orca couldn't pair with it again over SSH. Nothing on the host was stopped. Reconnect to try again."
                )
              : wakeFailed
                ? wakeFailure
                : waking
                  ? translate(
                      'auto.components.terminal.pane.TerminalRemoteRuntimeReconnectBanner.wakingBody',
                      'This terminal resumes once the machine is running.'
                    )
                  : retrying
                    ? translate(
                        'auto.components.terminal.pane.TerminalRemoteRuntimeReconnectBanner.retryingBody',
                        'Orca is retrying automatically. This terminal will resume if the connection returns.'
                      )
                    : translate(
                        'auto.components.terminal.pane.TerminalRemoteRuntimeReconnectBanner.disconnectedBody',
                        'Automatic retries stopped. Reconnect to resume this terminal session.'
                      )}
          </div>
        </div>
        {!retrying ? (
          <Button size="sm" onClick={onReconnect}>
            {wakeFailed
              ? translate(
                  'auto.components.terminal.pane.TerminalRemoteRuntimeReconnectBanner.retryWakeButton',
                  'Retry'
                )
              : translate(
                  'auto.components.terminal.pane.TerminalRemoteRuntimeReconnectBanner.reconnectButton',
                  'Reconnect'
                )}
          </Button>
        ) : null}
      </div>
    </div>
  )
}

/** Keyed per pane: holds a retrying banner back until recovery outlasts the delay. */
export function DelayedRemoteRuntimeReconnectBanner({
  epoch,
  ...props
}: Parameters<typeof TerminalRemoteRuntimeReconnectBanner>[0] & {
  epoch: number
}): React.JSX.Element | null {
  const revealed = useRemoteRuntimeRecoveryBannerRevealed(
    props.phase === 'disconnected' ||
      Boolean(props.wslHostUnavailable) ||
      Boolean(props.pairingRefused) ||
      Boolean(props.stoppedMachine && !props.wakingMachineName)
  )
  return revealed ? <TerminalRemoteRuntimeReconnectBanner key={epoch} {...props} /> : null
}
