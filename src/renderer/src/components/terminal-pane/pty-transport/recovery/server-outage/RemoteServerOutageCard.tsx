import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { LoadingSpinner } from '@/components/ui/LoadingSpinner'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { CopyTextButton } from '@/components/clipboard/CopyTextButton'
import { cn } from '@/lib/class-names'
import { useAppStore } from '@/store/index'
import { useIntlLocale, useTranslate } from '@/i18n/use-translate'
import { useCalmStatusReveal } from '@/runtime/hosts/connections/use-calm-status-reveal'
import { tailscalePingCommand } from '../../../../../../../shared/remote-runtime/remote-runtime-tailscale-hint'
import {
  remoteRuntimeDownForCompactLabel,
  remoteRuntimeRecoveryCopy,
  remoteServerCantReachTitle
} from '../../remote-runtime/recovery/remote-runtime-recovery-copy'
import { useRecoveryClock } from '../../remote-runtime/recovery/use-recovery-clock'
import {
  usePublishRemoteServerNoticeShowing,
  useRemoteServerOutageCardInputs
} from './remote-server-notice-claims'
import { useRemoteServerOutageNudge } from './remote-server-outage-signals'
import {
  reconnectRemoteServerNow,
  selectRemoteServerOutageCause,
  selectRuntimeServerName,
  selectRuntimeServerTailscaleHost
} from './remote-server-outage'

const FADE_OUT_MS = 150
const NUDGE_MS = 500

type ShownCard = { downSince: number | null; stopped: boolean }

/** One line per down server for the whole window; Details holds the rest. */
export function RemoteServerOutageCard({
  environmentId
}: {
  environmentId: string
}): React.JSX.Element | null {
  const { speaking, since, stopped } = useRemoteServerOutageCardInputs(environmentId)
  const reveal = useCalmStatusReveal(speaking, false, since)
  usePublishRemoteServerNoticeShowing(environmentId, reveal.visible)
  const [shown, setShown] = useState<ShownCard | null>(null)
  if (
    reveal.visible &&
    (shown === null || shown.downSince !== reveal.downSince || shown.stopped !== stopped)
  ) {
    setShown({ downSince: reveal.downSince, stopped })
  }
  // Why kept briefly: the card fades out instead of vanishing when the server returns.
  useEffect(() => {
    if (reveal.visible) {
      return
    }
    const timer = window.setTimeout(() => setShown(null), FADE_OUT_MS)
    return () => window.clearTimeout(timer)
  }, [reveal.visible])
  if (shown === null) {
    return null
  }
  return (
    <RemoteServerOutageCardLine
      environmentId={environmentId}
      downSince={shown.downSince}
      stopped={shown.stopped}
      leaving={!reveal.visible}
    />
  )
}

function useNudging(environmentId: string): boolean {
  const nudges = useRemoteServerOutageNudge(environmentId)
  const [seen, setSeen] = useState(nudges)
  const [nudging, setNudging] = useState(false)
  if (nudges !== seen) {
    setSeen(nudges)
    setNudging(true)
  }
  useEffect(() => {
    if (!nudging) {
      return
    }
    const timer = window.setTimeout(() => setNudging(false), NUDGE_MS)
    return () => window.clearTimeout(timer)
  }, [nudging, nudges])
  return nudging
}

export function RemoteServerOutageCardLine({
  environmentId,
  downSince,
  stopped,
  leaving = false
}: {
  environmentId: string
  downSince: number | null
  stopped: boolean
  leaving?: boolean
}): React.JSX.Element {
  const t = useTranslate()
  const intlLocale = useIntlLocale()
  const serverName = useAppStore((state) => selectRuntimeServerName(state, environmentId))
  const cause = useAppStore((state) => selectRemoteServerOutageCause(state, environmentId))
  const tailscaleHost = useAppStore((state) =>
    selectRuntimeServerTailscaleHost(state, environmentId)
  )
  const nudging = useNudging(environmentId)
  const [detailsOpen, setDetailsOpen] = useState(false)
  const now = useRecoveryClock(downSince !== null && !leaving)
  const copy = remoteRuntimeRecoveryCopy(cause, serverName, t)
  const title = stopped ? remoteServerCantReachTitle(serverName, t) : copy.title
  const timer =
    downSince === null ? null : remoteRuntimeDownForCompactLabel(now - downSince, intlLocale)
  const reconnect = (): void => {
    setDetailsOpen(false)
    reconnectRemoteServerNow(environmentId)
  }
  const showTailscale = cause === 'connection-lost' && tailscaleHost !== null
  return (
    <div
      data-remote-server-outage-notice={environmentId}
      data-terminal-remote-runtime-recovery-cause={cause}
      data-remote-server-outage-state={stopped ? 'stopped' : 'retrying'}
      className={cn(
        'pointer-events-auto flex max-w-full items-center gap-2.5 rounded-[10px] border border-border bg-card py-2.5 pr-2 pl-3 text-[13px] text-card-foreground shadow-floating transition-opacity duration-150',
        leaving && 'pointer-events-none opacity-0',
        nudging && 'remote-server-outage-nudge'
      )}
      role="status"
      aria-live="polite"
    >
      {stopped ? (
        <span aria-hidden className="size-[7px] shrink-0 rounded-full bg-status-warning" />
      ) : (
        <LoadingSpinner className="size-3 shrink-0 text-muted-foreground" />
      )}
      <span className="min-w-0 truncate font-semibold">{title}</span>
      {timer !== null ? (
        // Why hidden: a per-second tick inside the live region would re-announce the card.
        <span aria-hidden="true" className="shrink-0 tabular-nums text-muted-foreground">
          {timer}
        </span>
      ) : null}
      {stopped ? (
        <Button size="xs" className="shrink-0" onClick={reconnect}>
          {t(
            'auto.components.terminal.pane.TerminalRemoteRuntimeReconnectBanner.reconnectButton',
            'Reconnect'
          )}
        </Button>
      ) : (
        <Popover open={detailsOpen} onOpenChange={setDetailsOpen}>
          <PopoverTrigger asChild>
            <Button
              size="xs"
              variant="ghost"
              className="shrink-0 text-muted-foreground"
              data-remote-server-outage-details=""
            >
              {t(
                'auto.components.terminal.pane.TerminalRemoteRuntimeReconnectBanner.detailsButton',
                'Details'
              )}
            </Button>
          </PopoverTrigger>
          <PopoverContent
            side="bottom"
            align="center"
            sideOffset={8}
            className="w-[300px] max-w-[calc(100vw-16px)] p-2 text-xs"
            data-remote-server-outage-details-popover={environmentId}
          >
            <div className="flex items-center gap-2 px-1 py-1">
              <span className="min-w-0 truncate text-[13px] font-semibold">{title}</span>
              {timer !== null ? (
                <span
                  aria-hidden="true"
                  className="ml-auto shrink-0 tabular-nums text-muted-foreground"
                >
                  {timer}
                </span>
              ) : null}
            </div>
            {showTailscale ? (
              <>
                <div className="px-1 py-1 text-muted-foreground">
                  {t(
                    'auto.components.terminal.pane.TerminalRemoteRuntimeReconnectBanner.tailscaleHintTitle',
                    'Check the Tailscale path'
                  )}
                </div>
                <div className="mx-1 mt-1 mb-1.5 flex min-w-0 items-center gap-1 rounded-md bg-muted py-1 pr-1 pl-2">
                  <code className="min-w-0 flex-1 truncate font-mono text-[11px] select-text">
                    {tailscalePingCommand(tailscaleHost)}
                  </code>
                  <CopyTextButton
                    text={tailscalePingCommand(tailscaleHost)}
                    label={t(
                      'auto.components.terminal.pane.TerminalRemoteRuntimeReconnectBanner.copyPingCommand',
                      'Copy command'
                    )}
                  />
                </div>
              </>
            ) : (
              <div className="px-1 py-1 leading-5 text-muted-foreground">{copy.body}</div>
            )}
            <div className="flex justify-end px-1 pt-0.5">
              <Button size="xs" onClick={reconnect}>
                {t(
                  'auto.components.terminal.pane.TerminalRemoteRuntimeReconnectBanner.reconnectNowButton',
                  'Reconnect now'
                )}
              </Button>
            </div>
          </PopoverContent>
        </Popover>
      )}
    </div>
  )
}
