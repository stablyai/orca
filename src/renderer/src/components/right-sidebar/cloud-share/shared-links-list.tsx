import React, { useId, useRef, useState } from 'react'
import { ChevronRight, Share2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { InlineError } from '@/components/ui/inline-error'
import { Skeleton } from '@/components/ui/skeleton'
import { OrcaSignInButton } from '@/components/OrcaSignInProgress'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/utils'
import type { ShareLink } from '../../../../../shared/hosted-sandbox/hosted-sandbox-share-wire'
import { ShareLinkRow, shareLinkState } from './share-link-row'

/** An ended link stays visible this long, so a revoke or expiry is seen, then drops off. */
const ENDED_VISIBLE_MS = 10 * 60_000

export type SharedLinksListProps = {
  status: 'loading' | 'ready' | 'error'
  shares: ShareLink[]
  now: number
  errorText?: string
  /** Shown under the error title (what to do next). */
  errorDetail?: string
  /** The error is "signed out": offer Sign in instead of Retry. */
  needsSignIn?: boolean
  retrying?: boolean
  onShare: () => void
  onRetry: () => void
  onCopy: (url: string) => Promise<boolean>
  onOpen: (share: ShareLink) => void
  onRevoke: (share: ShareLink) => Promise<boolean>
}

function endedAt(share: ShareLink, now: number): number | null {
  const state = shareLinkState(share, now)
  return state === 'revoked'
    ? (share.revokedAt ?? now)
    : state === 'expired'
      ? share.expiresAt
      : null
}

/** Active links, plus links that ended in the last few minutes. */
export function visibleShareLinks(shares: ShareLink[], now: number): ShareLink[] {
  return shares.filter((share) => {
    const ended = endedAt(share, now)
    return ended === null || now - ended < ENDED_VISIBLE_MS
  })
}

/** The Ports panel's "Shared links" section for an Orca Cloud workspace. */
export function SharedLinksList({
  status,
  shares,
  now,
  errorText,
  errorDetail,
  needsSignIn = false,
  retrying = false,
  onShare,
  onRetry,
  onCopy,
  onOpen,
  onRevoke
}: SharedLinksListProps): React.JSX.Element {
  const t = useTranslate()
  const listId = useId()
  const [collapsed, setCollapsed] = useState(false)
  const [announcement, setAnnouncement] = useState('')
  const shareButtonRef = useRef<HTMLButtonElement>(null)
  const onRevoked = (): void => {
    // Cleared first so a second revoke is announced again.
    setAnnouncement('')
    requestAnimationFrame(() =>
      setAnnouncement(
        t('auto.components.right.sidebar.CloudShare.revokedAnnouncement', 'Link turned off')
      )
    )
    shareButtonRef.current?.focus()
  }
  const visible = visibleShareLinks(shares, now)
  const activeCount = visible.filter((share) => shareLinkState(share, now) === 'active').length

  return (
    <section className="px-3 pt-2" aria-labelledby={`${listId}-heading`}>
      <div className="sticky top-0 z-10 mb-1 flex items-center gap-1 border-b border-border/40 bg-background py-1">
        <h3 id={`${listId}-heading`} className="flex min-w-0 flex-1">
          <button
            type="button"
            className="flex min-w-0 flex-1 items-center gap-1 text-left text-muted-foreground transition-colors hover:text-foreground"
            onClick={() => setCollapsed((current) => !current)}
            aria-expanded={!collapsed}
            aria-controls={listId}
          >
            <ChevronRight
              size={12}
              className={cn(
                'shrink-0 transition-transform motion-reduce:transition-none',
                !collapsed && 'rotate-90'
              )}
            />
            <span className="text-3xs font-semibold uppercase tracking-wider">
              {t('auto.components.right.sidebar.CloudShare.section', 'Shared links')}
            </span>
            {activeCount > 0 && (
              <span className="ml-1 text-3xs text-muted-foreground">{activeCount}</span>
            )}
          </button>
        </h3>
        <Button
          ref={shareButtonRef}
          type="button"
          variant="ghost"
          size="xs"
          className="-mr-1 shrink-0"
          onClick={onShare}
        >
          <Share2 className="size-3" />
          {t('auto.components.right.sidebar.CloudShare.shareButton', 'Share…')}
        </Button>
      </div>
      {!collapsed && (
        <div id={listId}>
          {status === 'loading' && (
            <div aria-busy className="flex items-center gap-2 py-1">
              <span className="sr-only">
                {t('auto.components.right.sidebar.CloudShare.loading', 'Loading shared links…')}
              </span>
              <Skeleton className="size-5 shrink-0" />
              <div className="min-w-0 flex-1 space-y-1">
                <Skeleton className="h-3 w-28" />
                <Skeleton className="h-2.5 w-16" />
              </div>
            </div>
          )}
          {status === 'error' && (
            // Neutral (status, not alert): background refreshes would otherwise interrupt.
            <InlineError
              tone="neutral"
              density="compact"
              className="my-1"
              title={errorText}
              detail={errorDetail}
              retryLabel={
                needsSignIn
                  ? undefined
                  : t('auto.components.right.sidebar.CloudShare.retry', 'Retry')
              }
              onRetry={needsSignIn ? undefined : onRetry}
              retrying={retrying}
            />
          )}
          {status === 'error' && needsSignIn && (
            <div className="mb-1">
              <OrcaSignInButton variant="outline" size="xs">
                {t('auto.components.right.sidebar.CloudShare.signIn', 'Sign in to Orca')}
              </OrcaSignInButton>
            </div>
          )}
          {status === 'loading' ? null : visible.length === 0 && status !== 'error' ? (
            <p className="py-1 text-xs text-muted-foreground">
              {t(
                'auto.components.right.sidebar.CloudShare.empty',
                'No active links. Share a port to open it in someone’s browser.'
              )}
            </p>
          ) : (
            visible.map((share) => (
              <ShareLinkRow
                key={share.id}
                share={share}
                now={now}
                onCopy={onCopy}
                onOpen={onOpen}
                onRevoke={onRevoke}
                onRevoked={onRevoked}
              />
            ))
          )}
          <span className="sr-only" role="status" aria-live="polite">
            {announcement}
          </span>
        </div>
      )}
    </section>
  )
}
