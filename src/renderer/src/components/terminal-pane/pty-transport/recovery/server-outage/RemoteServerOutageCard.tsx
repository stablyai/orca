import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { LoadingSpinner } from '@/components/ui/LoadingSpinner'
import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { CopyTextButton } from '@/components/clipboard/CopyTextButton'
import { cn } from '@/lib/class-names'
import { useNow } from '@/lib/window-activity/use-now'
import { useAppStore } from '@/store/index'
import { useIntlLocale, useTranslate } from '@/i18n/use-translate'
import { useCalmStatusReveal } from '@/runtime/hosts/connections/use-calm-status-reveal'
import { tailscalePingCommand } from '../../../../../../../shared/remote-runtime/remote-runtime-tailscale-hint'
import {
  remoteRuntimeDownForCompactLabel,
  remoteRuntimeRecoveryCopy,
  remoteServerCantReachTitle
} from '../../remote-runtime/recovery/remote-runtime-recovery-copy'
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
// Why: a tab switch drops one surface's speaker an effect before the next one speaks.
const SPEAKER_SWAP_GRACE_MS = 100
const RECONNECT_COOLDOWN_MS = 2_000

function useHeldTrue(value: boolean, holdMs: number): boolean {
  const [held, setHeld] = useState(value)
  if (value && !held) {
    setHeld(true)
  }
  useEffect(() => {
    if (value || !held) {
      return
    }
    const timer = window.setTimeout(() => setHeld(false), holdMs)
    return () => window.clearTimeout(timer)
  }, [held, holdMs, value])
  return held
}

type ShownCard = { downSince: number | null; stopped: boolean }

/** One line per down server for the whole window; Details holds the rest. */
export function RemoteServerOutageCard({
  environmentId
}: {
  environmentId: string
}): React.JSX.Element | null {
  const { speaking, down, since, stopped } = useRemoteServerOutageCardInputs(environmentId)
  const speakingNow = useHeldTrue(speaking, SPEAKER_SWAP_GRACE_MS)
  const reveal = useCalmStatusReveal(speakingNow, false, since)
  const [shown, setShown] = useState<ShownCard | null>(null)
  // Only retrying cards keep the healthy hold, so "Can't reach" fades as soon as the panes recover.
  const visible = reveal.visible && (down ? speakingNow : shown?.stopped === false)
  usePublishRemoteServerNoticeShowing(environmentId, visible)
  // Keep the last outage state while the healthy hold and exit fade finish.
  if (
    visible &&
    (shown === null ||
      (down && (shown.downSince !== reveal.downSince || shown.stopped !== stopped)))
  ) {
    setShown({ downSince: reveal.downSince, stopped })
  }
  // Why kept briefly: the card fades out instead of vanishing when the server returns.
  useEffect(() => {
    if (visible) {
      return
    }
    const timer = window.setTimeout(() => setShown(null), FADE_OUT_MS)
    return () => window.clearTimeout(timer)
  }, [visible])
  if (shown === null) {
    return null
  }
  return (
    <RemoteServerOutageCardLine
      environmentId={environmentId}
      downSince={shown.downSince}
      stopped={shown.stopped}
      interactive={down}
      leaving={!visible}
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

// Why a slot: the server name must ellipsize before the words around it, wherever a locale puts it.
const SERVER_SLOT = '\u2063'

function ServerTitle({
  template,
  serverName,
  className
}: {
  template: string
  serverName: string
  className?: string
}): React.JSX.Element {
  const [before, after] = template.split(SERVER_SLOT)
  if (after === undefined) {
    return <span className={cn('min-w-0 truncate', className)}>{template}</span>
  }
  return (
    <span className={cn('flex min-w-0 overflow-hidden', className)}>
      {before ? <span className="shrink-0 whitespace-pre">{before}</span> : null}
      {/* Why only the name shrinks: any shrink on the words around it ellipsizes them first. */}
      <span className="min-w-[3ch] truncate" title={serverName}>
        {serverName}
      </span>
      {after ? <span className="shrink-0 whitespace-pre">{after}</span> : null}
    </span>
  )
}

export function RemoteServerOutageCardLine({
  environmentId,
  downSince,
  stopped,
  interactive = true,
  leaving = false
}: {
  environmentId: string
  downSince: number | null
  stopped: boolean
  interactive?: boolean
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
  const inert = leaving || !interactive
  if (detailsOpen && (stopped || inert)) {
    setDetailsOpen(false)
  }
  const detailsRef = useRef<HTMLDivElement>(null)
  const now = useNow(1_000, downSince !== null && !leaving)
  const copy = remoteRuntimeRecoveryCopy(cause, serverName, t)
  const titleTemplate = stopped
    ? remoteServerCantReachTitle(SERVER_SLOT, t)
    : remoteRuntimeRecoveryCopy(cause, SERVER_SLOT, t).title
  const timer =
    downSince === null ? null : remoteRuntimeDownForCompactLabel(now - downSince, intlLocale)
  const [cooling, setCooling] = useState(false)
  useEffect(() => {
    if (!cooling) {
      return
    }
    const timer = window.setTimeout(() => setCooling(false), RECONNECT_COOLDOWN_MS)
    return () => window.clearTimeout(timer)
  }, [cooling])
  const reconnect = (): void => {
    setDetailsOpen(false)
    setCooling(true)
    reconnectRemoteServerNow(environmentId)
  }
  const showTailscale = cause === 'connection-lost' && tailscaleHost !== null
  return (
    <Popover open={detailsOpen} onOpenChange={setDetailsOpen}>
      <PopoverAnchor asChild>
        <div
          data-remote-server-outage-notice={environmentId}
          data-terminal-remote-runtime-recovery-cause={cause}
          data-remote-server-outage-state={stopped ? 'stopped' : 'retrying'}
          className={cn(
            'pointer-events-auto flex max-w-full items-center gap-2.5 rounded-[10px] border border-border bg-card py-2.5 pr-2 pl-3 text-[13px] text-card-foreground shadow-floating transition-opacity duration-150',
            inert && 'pointer-events-none',
            leaving && 'opacity-0',
            nudging && 'remote-server-outage-nudge'
          )}
          role="status"
          aria-live="polite"
          inert={inert}
        >
          {stopped ? (
            <span aria-hidden className="size-[7px] shrink-0 rounded-full bg-status-warning" />
          ) : (
            <span className="inline-flex shrink-0 text-muted-foreground">
              <LoadingSpinner className="size-3" />
            </span>
          )}
          <ServerTitle
            template={titleTemplate}
            serverName={serverName}
            className="mr-auto font-semibold"
          />
          {timer !== null ? (
            // Why hidden: a per-second tick inside the live region would re-announce the card.
            <span aria-hidden="true" className="shrink-0 tabular-nums text-muted-foreground">
              {timer}
            </span>
          ) : null}
          {stopped ? (
            <Button size="xs" className="shrink-0" disabled={cooling} onClick={reconnect}>
              {t(
                'auto.components.terminal.pane.TerminalRemoteRuntimeReconnectBanner.reconnectButton',
                'Reconnect'
              )}
            </Button>
          ) : (
            <PopoverTrigger asChild>
              <Button
                size="xs"
                variant="ghost-muted-disclosure"
                className="shrink-0"
                data-remote-server-outage-details=""
              >
                {t(
                  'auto.components.terminal.pane.TerminalRemoteRuntimeReconnectBanner.detailsButton',
                  'Details'
                )}
              </Button>
            </PopoverTrigger>
          )}
        </div>
      </PopoverAnchor>
      <PopoverContent
        ref={detailsRef}
        side="bottom"
        align="start"
        sideOffset={8}
        className="w-[var(--radix-popover-trigger-width)]"
        data-remote-server-outage-details-popover={environmentId}
        inert={inert}
        // Why the panel itself: focusing its first control would ring the copy button on every open.
        onOpenAutoFocus={(event) => {
          event.preventDefault()
          detailsRef.current?.focus()
        }}
      >
        <div className="p-2 text-xs">
          {showTailscale ? (
            <>
              <div className="px-1 py-1 text-muted-foreground">
                {t(
                  'auto.components.terminal.pane.TerminalRemoteRuntimeReconnectBanner.tailscaleHintTitle',
                  'Check the Tailscale path'
                )}
              </div>
              <div className="mx-1 mt-1 mb-1.5 flex min-w-0 items-center gap-1 rounded-md bg-muted py-1 pr-1 pl-2">
                <code className="min-w-0 flex-1 truncate font-mono text-2xs select-text">
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
            <Button size="xs" disabled={cooling} onClick={reconnect}>
              {t(
                'auto.components.terminal.pane.TerminalRemoteRuntimeReconnectBanner.reconnectNowButton',
                'Reconnect now'
              )}
            </Button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  )
}
