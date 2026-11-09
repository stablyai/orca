import React, { useEffect, useId, useRef, useState } from 'react'
import { Check, Copy, ExternalLink, Globe, Link2Off, Loader2, Users } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/utils'
import type {
  ShareLink,
  ShareState
} from '../../../../../shared/hosted-sandbox/hosted-sandbox-share-wire'
import { formatShareExpiryDate, formatShareTimeLeft } from './share-link-status'

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
  withLabel = false,
  initialCopied = false
}: {
  url: string
  onCopy: (url: string) => Promise<boolean>
  className?: string
  withLabel?: boolean
  /** Already copied (the dialog copies on create), so the button starts on "Copied". */
  initialCopied?: boolean
}): React.JSX.Element {
  const t = useTranslate()
  const [copied, setCopied] = useState(initialCopied)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => clearTimeout(timer.current ?? undefined), [])
  useEffect(() => {
    if (!initialCopied) {
      return
    }
    const reset = setTimeout(() => setCopied(false), COPIED_MS)
    return () => clearTimeout(reset)
  }, [initialCopied])
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
  const [revokeFailed, setRevokeFailed] = useState(false)
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
    setRevokeFailed(false)
    const revoked = await revokeSafely(onRevoke, share)
    setRevoking(false)
    // A failed revoke keeps the confirm open with the reason, so "Turn off" can simply be tried again.
    setRevokeFailed(!revoked)
    if (revoked) {
      setConfirming(false)
      if (onRevoked) {
        onRevoked()
      } else {
        rowRef.current?.focus()
      }
    }
  }
  const closeConfirm = (): void => {
    setConfirming(false)
    setRevokeFailed(false)
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
        <div className={cn('flex min-w-0 flex-1 items-center gap-2', !active && 'opacity-60')}>
          <div className="flex size-5 shrink-0 items-center justify-center text-muted-foreground">
            <ShareAudienceIcon audience={share.audience} />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-center gap-1.5">
              {showPort && (
                <span className="text-xs font-medium text-foreground">:{share.port}</span>
              )}
              {share.audience === 'public' ? (
                <span className="text-foreground">
                  <Badge variant="paneLabel">{audienceLabel}</Badge>
                </span>
              ) : (
                <span className="truncate text-xs text-muted-foreground">{audienceLabel}</span>
              )}
            </div>
            <Tooltip>
              <TooltipTrigger asChild>
                <div className="truncate text-2xs text-muted-foreground">{meta}</div>
              </TooltipTrigger>
              <TooltipContent side="top" sideOffset={4}>
                {state === 'revoked'
                  ? t(
                      'auto.components.right.sidebar.CloudShare.revokedAt',
                      'Turned off {{value0}}',
                      {
                        value0: formatShareExpiryDate(share.revokedAt ?? now)
                      }
                    )
                  : state === 'expired'
                    ? t(
                        'auto.components.right.sidebar.CloudShare.expiredAt',
                        'Expired {{value0}}',
                        {
                          value0: formatShareExpiryDate(share.expiresAt)
                        }
                      )
                    : t(
                        'auto.components.right.sidebar.CloudShare.expiresAt',
                        'Expires {{value0}}',
                        {
                          value0: formatShareExpiryDate(share.expiresAt)
                        }
                      )}
              </TooltipContent>
            </Tooltip>
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
          className="mt-1 space-y-1.5 rounded-md border border-border bg-muted/40 p-2"
          role="group"
          aria-labelledby={confirmId}
          aria-describedby={`${confirmId}-detail`}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.stopPropagation()
              closeConfirm()
            }
          }}
        >
          <div className="space-y-0.5">
            <p id={confirmId} className="text-xs font-medium text-foreground">
              {share.audience === 'public'
                ? t(
                    'auto.components.right.sidebar.CloudShare.confirmPublic',
                    'Turn off the public link to :{{value0}}?',
                    {
                      value0: share.port
                    }
                  )
                : t(
                    'auto.components.right.sidebar.CloudShare.confirmTeam',
                    'Turn off the team link to :{{value0}}?',
                    {
                      value0: share.port
                    }
                  )}
            </p>
            <p id={`${confirmId}-detail`} className="text-2xs text-muted-foreground">
              {t(
                'auto.components.right.sidebar.CloudShare.confirmDetail',
                'People with it can’t open it anymore.'
              )}
            </p>
            {revokeFailed && (
              <p className="text-2xs text-destructive" role="alert">
                {t(
                  'auto.components.right.sidebar.CloudShare.revokeFailed',
                  'Couldn’t turn it off. Try again.'
                )}
              </p>
            )}
          </div>
          <div className="flex items-center justify-end gap-1">
            <Button
              ref={cancelRef}
              type="button"
              variant="ghost"
              size="xs"
              aria-disabled={revoking}
              onClick={() => {
                if (!revoking) {
                  closeConfirm()
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
        </div>
      )}
    </div>
  )
}
