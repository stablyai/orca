import React, { useEffect, useId, useRef, useState } from 'react'
import { Check, Copy, ExternalLink, Globe, Link2Off, Loader2, Users } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useTranslate } from '@/i18n/use-translate'
import { formatUiNarrowDuration, formatUiNarrowRelativeTime } from '@/i18n/relative-time-format'
import { cn } from '@/lib/utils'
import type {
  ShareLink,
  ShareState
} from '../../../../../shared/hosted-sandbox/hosted-sandbox-share-wire'

const COPIED_MS = 1600
/** Lets the Share dialog keep Escape for the inline confirm instead of closing. */
export const SHARE_CONFIRM_ATTRIBUTE = 'data-share-confirm'

/** The server's state, with expiry applied locally so a row greys out without a refetch. */
export function shareLinkState(share: ShareLink, now: number): ShareState {
  if (share.state === 'active' && share.expiresAt <= now) {
    return 'expired'
  }
  return share.state
}

/** "50m" / "23h" / "6d": time left, for the dense sidebar row. */
export function formatShareTimeLeft(expiresAt: number, now: number): string {
  const minutes = Math.max(1, Math.round((expiresAt - now) / 60_000))
  if (minutes < 60) {
    return formatUiNarrowDuration(minutes, 'minute')
  }
  const hours = Math.round(minutes / 60)
  return hours < 48
    ? formatUiNarrowDuration(hours, 'hour')
    : formatUiNarrowDuration(Math.round(hours / 24), 'day')
}

/** "in 50m" / "in 23h" / "in 6d". */
export function formatShareExpiry(expiresAt: number, now: number): string {
  const minutes = Math.max(1, Math.round((expiresAt - now) / 60_000))
  if (minutes < 60) {
    return formatUiNarrowRelativeTime(minutes, 'minute')
  }
  const hours = Math.round(minutes / 60)
  return hours < 48
    ? formatUiNarrowRelativeTime(hours, 'hour')
    : formatUiNarrowRelativeTime(Math.round(hours / 24), 'day')
}

export function ShareAudienceIcon({
  audience,
  className
}: {
  audience: ShareLink['audience']
  className?: string
}): React.JSX.Element {
  const Icon = audience === 'public' ? Globe : Users
  return <Icon size={13} className={className} aria-hidden />
}

export function useShareAudienceLabel(audience: ShareLink['audience']): string {
  const t = useTranslate()
  return audience === 'public'
    ? t('auto.components.right.sidebar.CloudShare.audiencePublicShort', 'Public')
    : t('auto.components.right.sidebar.CloudShare.audienceTeam', 'Team only')
}

/** Copy with in-place feedback: the icon swaps to a check and a live region announces it. */
export function CopyShareLinkButton({
  url,
  onCopy,
  className,
  withLabel = false
}: {
  url: string
  onCopy: (url: string) => Promise<boolean>
  className?: string
  withLabel?: boolean
}): React.JSX.Element {
  const t = useTranslate()
  const [copied, setCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => clearTimeout(timer.current ?? undefined), [])
  const label = copied
    ? t('auto.components.right.sidebar.CloudShare.copied', 'Copied')
    : t('auto.components.right.sidebar.CloudShare.copyLink', 'Copy link')
  const copy = async (): Promise<void> => {
    if (!(await onCopy(url))) {
      return
    }
    setCopied(true)
    clearTimeout(timer.current ?? undefined)
    timer.current = setTimeout(() => setCopied(false), COPIED_MS)
  }
  const icon = copied ? <Check size={13} /> : <Copy size={13} />
  return (
    <>
      {withLabel ? (
        <Button type="button" variant="outline" size="sm" className={className} onClick={copy}>
          {icon}
          {copied
            ? t('auto.components.right.sidebar.CloudShare.copied', 'Copied')
            : t('auto.components.right.sidebar.CloudShare.copy', 'Copy')}
        </Button>
      ) : (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              className={className}
              aria-label={label}
              onClick={copy}
            >
              {icon}
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top" sideOffset={4}>
            {label}
          </TooltipContent>
        </Tooltip>
      )}
      <span className="sr-only" role="status" aria-live="polite">
        {copied
          ? t('auto.components.right.sidebar.CloudShare.copiedAnnouncement', 'Link copied')
          : ''}
      </span>
    </>
  )
}

/** A thrown revoke counts as "still on", so the row always leaves its pending state. */
async function revokeSafely(
  onRevoke: (share: ShareLink) => Promise<boolean>,
  share: ShareLink
): Promise<boolean> {
  try {
    return await onRevoke(share)
  } catch {
    return false
  }
}

export function ShareLinkRow({
  share,
  now,
  onCopy,
  onOpen,
  onRevoke,
  onRevoked,
  showPort = true,
  alwaysShowActions = false
}: {
  share: ShareLink
  now: number
  onCopy: (url: string) => Promise<boolean>
  onOpen: (share: ShareLink) => void
  /** Resolves true when the link is off; the row stays in "turning off" until then. */
  onRevoke: (share: ShareLink) => Promise<boolean>
  /** Where focus goes once this row's actions disappear; defaults to the row itself. */
  onRevoked?: () => void
  showPort?: boolean
  alwaysShowActions?: boolean
}): React.JSX.Element {
  const t = useTranslate()
  const confirmId = useId()
  const [confirming, setConfirming] = useState(false)
  const [revoking, setRevoking] = useState(false)
  const rowRef = useRef<HTMLDivElement>(null)
  const cancelRef = useRef<HTMLButtonElement>(null)
  const turnOffRef = useRef<HTMLButtonElement>(null)
  const wasConfirming = useRef(false)
  const state = shareLinkState(share, now)
  const active = state === 'active'
  const audienceLabel = useShareAudienceLabel(share.audience)

  useEffect(() => {
    if (confirming) {
      cancelRef.current?.focus()
    } else if (wasConfirming.current && active) {
      turnOffRef.current?.focus()
    }
    wasConfirming.current = confirming
  }, [confirming, active])

  const revoke = async (): Promise<void> => {
    setRevoking(true)
    const revoked = await revokeSafely(onRevoke, share)
    setRevoking(false)
    setConfirming(false)
    if (revoked) {
      if (onRevoked) {
        onRevoked()
      } else {
        rowRef.current?.focus()
      }
    }
  }

  const status =
    state === 'revoked'
      ? t('auto.components.right.sidebar.CloudShare.revoked', 'Turned off')
      : state === 'expired'
        ? t('auto.components.right.sidebar.CloudShare.expired', 'Expired')
        : t('auto.components.right.sidebar.CloudShare.timeLeft', '{{value0}} left', {
            value0: formatShareTimeLeft(share.expiresAt, now)
          })
  const meta =
    active && share.allowWake
      ? t('auto.components.right.sidebar.CloudShare.statusWithWake', '{{value0}} · Can wake', {
          value0: status
        })
      : status

  return (
    <div
      ref={rowRef}
      tabIndex={-1}
      className={cn(
        'group -mx-1 rounded px-1 py-1 transition-colors focus:outline-none',
        active && !confirming && 'hover:bg-accent/50'
      )}
      data-state={state}
    >
      <div className="flex items-center gap-2">
        <div
          className={cn('flex min-w-0 flex-1 items-center gap-2', !active && 'opacity-60')}
          title={share.url}
        >
          <div className="flex size-5 shrink-0 items-center justify-center text-muted-foreground">
            <ShareAudienceIcon audience={share.audience} />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-center gap-1.5">
              {showPort && (
                <span className="text-xs font-medium text-foreground">:{share.port}</span>
              )}
              <span
                className={cn(
                  'truncate text-xs',
                  share.audience === 'public' ? 'text-foreground' : 'text-muted-foreground'
                )}
              >
                {audienceLabel}
              </span>
            </div>
            <div className="truncate text-2xs text-muted-foreground">{meta}</div>
          </div>
        </div>
        {active && !confirming && (
          <div
            className={cn(
              'flex shrink-0 items-center gap-0.5',
              !alwaysShowActions &&
                'transition-opacity can-hover:opacity-0 group-hover:opacity-100 group-focus-within:opacity-100'
            )}
          >
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  aria-label={t('auto.components.right.sidebar.CloudShare.open', 'Open link')}
                  onClick={() => onOpen(share)}
                >
                  <ExternalLink size={13} />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="top" sideOffset={4}>
                {t('auto.components.right.sidebar.CloudShare.open', 'Open link')}
              </TooltipContent>
            </Tooltip>
            <CopyShareLinkButton url={share.url} onCopy={onCopy} />
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  ref={turnOffRef}
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  aria-label={t(
                    'auto.components.right.sidebar.CloudShare.turnOffLink',
                    'Turn off link'
                  )}
                  onClick={() => setConfirming(true)}
                >
                  <Link2Off size={13} />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="top" sideOffset={4}>
                {t('auto.components.right.sidebar.CloudShare.turnOffLink', 'Turn off link')}
              </TooltipContent>
            </Tooltip>
          </div>
        )}
      </div>
      {active && confirming && (
        <div
          {...{ [SHARE_CONFIRM_ATTRIBUTE]: '' }}
          className="mt-1 flex items-center gap-1.5 rounded-md border border-border bg-muted/40 py-1 pr-1 pl-2"
          role="group"
          aria-labelledby={confirmId}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.stopPropagation()
              setConfirming(false)
            }
          }}
        >
          <span id={confirmId} className="min-w-0 flex-1 truncate text-2xs text-foreground">
            {t('auto.components.right.sidebar.CloudShare.confirmText', 'Turn off this link?')}
          </span>
          <Button
            ref={cancelRef}
            type="button"
            variant="ghost"
            size="xs"
            aria-disabled={revoking}
            onClick={() => {
              if (!revoking) {
                setConfirming(false)
              }
            }}
          >
            {t('auto.components.right.sidebar.CloudShare.cancel', 'Cancel')}
          </Button>
          <Button
            type="button"
            variant="destructive"
            size="xs"
            disabled={revoking}
            onClick={() => void revoke()}
          >
            {/* Spinner and label share one grid cell, so the button keeps its width. */}
            <span className="grid place-items-center">
              <span className={cn('col-start-1 row-start-1', revoking && 'invisible')}>
                {t('auto.components.right.sidebar.CloudShare.turnOff', 'Turn off')}
              </span>
              {revoking && (
                <Loader2 className="col-start-1 row-start-1 size-3 animate-spin motion-reduce:animate-none" />
              )}
            </span>
          </Button>
        </div>
      )}
    </div>
  )
}
