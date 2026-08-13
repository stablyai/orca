import { useLayoutEffect, useRef, useState } from 'react'
import { Loader2, RefreshCw, ServerOff, SquareTerminal } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import type { PtyTransportRecoveryState } from './pty-transport-types'

type VisibleRecoveryPhase = Extract<
  PtyTransportRecoveryState['phase'],
  'recovering' | 'backoff' | 'disconnected'
>

/** `ssh-pane` copy may never say the shell exited: a failed attach does not prove it did. */
type DisconnectedBannerVariant = 'remote-runtime' | 'ssh-pane'

const COMPACT_ACTIONS_MAX_WIDTH_PX = 240

function useCompactDisconnectedBannerActions(): {
  bannerRef: React.RefObject<HTMLDivElement | null>
  compactActions: boolean
} {
  const bannerRef = useRef<HTMLDivElement>(null)
  const [compactActions, setCompactActions] = useState(false)

  useLayoutEffect(() => {
    const pane = bannerRef.current?.parentElement
    if (!pane) {
      return
    }
    const sync = (): void => {
      setCompactActions(pane.getBoundingClientRect().width < COMPACT_ACTIONS_MAX_WIDTH_PX)
    }
    sync()
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', sync)
      return () => window.removeEventListener('resize', sync)
    }
    const observer = new ResizeObserver(sync)
    observer.observe(pane)
    return () => observer.disconnect()
  }, [])

  return { bannerRef, compactActions }
}

export function TerminalPaneDisconnectedBanner({
  phase,
  variant = 'remote-runtime',
  onReconnect,
  onStartNewTerminal,
  onRestoreTerminalFocus
}: {
  phase: VisibleRecoveryPhase
  variant?: DisconnectedBannerVariant
  onReconnect: () => void
  onStartNewTerminal?: () => void
  onRestoreTerminalFocus: () => void
}): React.JSX.Element {
  const retrying = phase !== 'disconnected'
  const sshPane = variant === 'ssh-pane'
  const { bannerRef, compactActions } = useCompactDisconnectedBannerActions()

  const title = sshPane
    ? translate(
        'auto.components.terminal.pane.TerminalPaneDisconnectedBanner.sshPaneTitle',
        'Terminal disconnected'
      )
    : retrying
      ? translate(
          'auto.components.terminal.pane.TerminalPaneDisconnectedBanner.retryingTitle',
          'Reconnecting to remote runtime'
        )
      : translate(
          'auto.components.terminal.pane.TerminalPaneDisconnectedBanner.disconnectedTitle',
          'Remote runtime disconnected'
        )

  const body = sshPane
    ? translate(
        'auto.components.terminal.pane.TerminalPaneDisconnectedBanner.sshPaneBody',
        'Orca cannot reach this terminal right now. Its shell may still be running, so starting a new one leaves it alone.'
      )
    : retrying
      ? translate(
          'auto.components.terminal.pane.TerminalPaneDisconnectedBanner.retryingBody',
          'Orca will retry for up to one minute. This terminal will resume if the connection returns.'
        )
      : translate(
          'auto.components.terminal.pane.TerminalPaneDisconnectedBanner.disconnectedBody',
          'Automatic retries stopped. Reconnect to resume this terminal session.'
        )

  const runRecoveryAction = (action: () => void): void => {
    try {
      action()
    } finally {
      onRestoreTerminalFocus()
    }
  }

  const reconnectLabel = sshPane
    ? translate(
        'auto.components.terminal.pane.TerminalPaneDisconnectedBanner.tryAgainButton',
        'Try again'
      )
    : translate(
        'auto.components.terminal.pane.TerminalPaneDisconnectedBanner.reconnectButton',
        'Reconnect'
      )
  const startNewTerminalLabel = translate(
    'auto.components.terminal.pane.TerminalPaneDisconnectedBanner.startNewTerminalButton',
    'Start a new terminal'
  )
  const reconnectButton = (
    <Button
      size={compactActions ? 'icon-xs' : 'sm'}
      aria-label={reconnectLabel}
      onClick={() => runRecoveryAction(onReconnect)}
    >
      {compactActions ? (
        <>
          <RefreshCw />
          <span className="sr-only">{reconnectLabel}</span>
        </>
      ) : (
        reconnectLabel
      )}
    </Button>
  )
  const startNewTerminalButton = onStartNewTerminal ? (
    <Button
      size={compactActions ? 'icon-xs' : 'sm'}
      variant="outline"
      aria-label={startNewTerminalLabel}
      onClick={() => runRecoveryAction(onStartNewTerminal)}
    >
      {compactActions ? (
        <>
          <SquareTerminal />
          <span className="sr-only">{startNewTerminalLabel}</span>
        </>
      ) : (
        startNewTerminalLabel
      )}
    </Button>
  ) : null

  return (
    <div
      ref={bannerRef}
      className="@container/disconnected-banner pointer-events-none absolute inset-x-0 top-3 bottom-3 z-30 flex items-end justify-center"
      data-terminal-remote-runtime-reconnect-banner={phase}
      data-terminal-pane-disconnected-variant={variant}
    >
      <div
        className="scrollbar-sleek pointer-events-auto flex max-h-full w-[calc(100%-1.5rem)] max-w-xl items-center gap-3 overflow-y-auto rounded-md border border-border bg-card/95 px-3 py-3 text-card-foreground shadow-xs backdrop-blur-[1px] @max-[360px]/disconnected-banner:flex-col @max-[360px]/disconnected-banner:items-stretch @max-[240px]/disconnected-banner:w-auto @max-[240px]/disconnected-banner:gap-0 @max-[240px]/disconnected-banner:p-0"
        role="status"
        aria-live="polite"
      >
        <div
          className={`flex size-8 shrink-0 items-center justify-center rounded-md border border-border bg-muted text-muted-foreground ${
            retrying
              ? '@max-[240px]/disconnected-banner:size-6'
              : '@max-[240px]/disconnected-banner:hidden'
          }`}
        >
          {retrying ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <ServerOff className="size-4" />
          )}
        </div>
        <div className="min-w-0 flex-1 @max-[240px]/disconnected-banner:sr-only">
          <div className="text-sm font-semibold">{title}</div>
          <div className="mt-0.5 text-xs leading-5 text-muted-foreground">{body}</div>
        </div>
        {!retrying ? (
          <div className="flex shrink-0 items-center gap-2 @max-[360px]/disconnected-banner:w-full @max-[360px]/disconnected-banner:flex-wrap @max-[360px]/disconnected-banner:justify-end @max-[240px]/disconnected-banner:justify-center @max-[240px]/disconnected-banner:gap-0">
            {compactActions ? (
              <Tooltip>
                <TooltipTrigger asChild>{reconnectButton}</TooltipTrigger>
                <TooltipContent side="top" sideOffset={4}>
                  {reconnectLabel}
                </TooltipContent>
              </Tooltip>
            ) : (
              reconnectButton
            )}
            {/* Not `destructive`: the remote shell keeps running, so styling this as a loss would
                itself overclaim. */}
            {compactActions && startNewTerminalButton ? (
              <Tooltip>
                <TooltipTrigger asChild>{startNewTerminalButton}</TooltipTrigger>
                <TooltipContent side="top" sideOffset={4}>
                  {startNewTerminalLabel}
                </TooltipContent>
              </Tooltip>
            ) : (
              startNewTerminalButton
            )}
          </div>
        ) : null}
      </div>
    </div>
  )
}
