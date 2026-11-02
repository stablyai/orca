import { useEffect, useState } from 'react'
import { Loader2, ServerOff } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import type { PtyTransportRecoveryState } from './pty-transport-types'
import type { WslHostUnavailableReason } from './use-wsl-host-unavailable-reason'
import { WslHostUnavailableBanner } from './WslHostUnavailableBanner'

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
  wslHostUnavailable = null
}: {
  phase: VisibleRecoveryPhase
  onReconnect: () => void
  /** The pane's WSL host cannot run: nothing is retrying, so say why instead. */
  wslHostUnavailable?: WslHostUnavailableReason | null
}): React.JSX.Element {
  if (wslHostUnavailable) {
    return <WslHostUnavailableBanner reason={wslHostUnavailable} />
  }
  const retrying = phase !== 'disconnected'

  return (
    <div
      className="pointer-events-none absolute inset-x-3 bottom-3 z-30 flex justify-center"
      data-terminal-remote-runtime-reconnect-banner={phase}
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
            {retrying
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
            {retrying
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
            {translate(
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
    props.phase === 'disconnected' || Boolean(props.wslHostUnavailable)
  )
  return revealed ? <TerminalRemoteRuntimeReconnectBanner key={epoch} {...props} /> : null
}
