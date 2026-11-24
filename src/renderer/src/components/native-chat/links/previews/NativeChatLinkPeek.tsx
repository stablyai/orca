import { useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import { NativeChatGitHubPeekBody, resolveGitHubPeekLink } from './NativeChatGitHubLinkPeek'
import { NativeChatWebPeekBody } from './NativeChatWebLinkPeek'
import { NativeChatLinkPeekContext } from './native-chat-link-peek-context'
import { previewableWebUrl } from './native-chat-web-link-preview'
import { CARD_OFFSET, sideWithRoom, WINDOW_MARGIN, type PeekSide } from './link-peek-side'
import { LinkPeekRetryContext, type LinkPeekRetryState } from './link-peek-retry-context'
import { parseGitHubIssueOrPRLink } from '../../../../../../shared/github/repositories/links'

/** Hover or focus a link to preview it: PRs and issues on its repo's GitHub host, or what a web page says about itself. */
export function NativeChatLinkPeek({
  href,
  githubFallback,
  githubFailedFallback,
  retryKey,
  overPopover = false,
  side = 'top',
  children
}: {
  href: string | undefined
  /** Where the card opens; it flips when there is no room. 'left' means beside the link: left, else
   *  right, else below, whichever has room. */
  side?: 'top' | 'bottom' | 'left'
  /** What a GitHub card shows until its details arrive, and if they never do, in place of the web
   *  page preview or the failure line: for a caller that already knows the item. */
  githubFallback?: ReactNode
  /** What a GitHub card shows above its failure line if the lookup fails, instead of `githubFallback`:
   *  only what stays true, so a failed card never passes off a known state as current. */
  githubFailedFallback?: ReactNode
  /** A key that retries a failed GitHub lookup while the link has focus and its card is open: a
   *  card's Retry is out of Tab's reach, as everything in a hover card is. Shown beside Retry and
   *  announced with the failure. Lowercase. */
  retryKey?: string
  /** The link sits in a popover: its card opens above it rather than under it. */
  overPopover?: boolean
  children: ReactNode
}): ReactNode {
  const { githubRepo, githubRoutingAuthorityKey, webPreviews } =
    useContext(NativeChatLinkPeekContext)
  const body = useMemo(() => {
    const webUrl = webPreviews ? previewableWebUrl(href) : null
    const webBody = webUrl ? (
      <NativeChatWebPeekBody
        key={webUrl}
        url={webUrl}
        runtimeEnvironmentId={webPreviews?.runtimeEnvironmentId ?? null}
      />
    ) : null
    const github = href ? resolveGitHubPeekLink(githubRepo, href) : null
    if (githubRepo && github) {
      return (
        <NativeChatGitHubPeekBody
          key={`repo:${githubRepo.repo.id}:${href}`}
          source={{ kind: 'repo', repo: githubRepo.repo }}
          link={github.link}
          otherRepoFallback={githubFallback ?? (github.ownRepo ? undefined : webBody)}
          failedFallback={githubFailedFallback}
        />
      )
    }
    // No chat repo on the link's host, as in a folder workspace: another repo on the chat's host
    // can still answer with its GitHub sign-in. A web page fetch can't read private repos.
    const routed = href && githubRoutingAuthorityKey ? parseGitHubIssueOrPRLink(href) : null
    if (routed && githubRoutingAuthorityKey) {
      return (
        <NativeChatGitHubPeekBody
          key={`routed:${githubRoutingAuthorityKey}:${href}`}
          source={{ kind: 'routed', authorityKey: githubRoutingAuthorityKey }}
          link={routed}
          otherRepoFallback={githubFallback ?? webBody}
          failedFallback={githubFailedFallback}
        />
      )
    }
    return webBody
  }, [
    githubFailedFallback,
    githubFallback,
    githubRepo,
    githubRoutingAuthorityKey,
    href,
    webPreviews
  ])
  if (!body) {
    return children
  }
  return (
    <LinkPeekCard body={body} side={side} retryKey={retryKey} overPopover={overPopover}>
      {children}
    </LinkPeekCard>
  )
}

function LinkPeekCard({
  body,
  side,
  retryKey,
  overPopover,
  children
}: {
  body: ReactNode
  side: 'top' | 'bottom' | 'left'
  retryKey: string | undefined
  overPopover: boolean
  children: ReactNode
}): ReactNode {
  const t = useTranslate()
  const [open, setOpen] = useState(false)
  const [placed, setPlaced] = useState<PeekSide>(side)
  const trigger = useRef<HTMLSpanElement>(null)
  const lookup = useRef<LinkPeekRetryState>({ status: 'idle' })
  const retryKeyHeld = useRef(false)
  const [failed, setFailed] = useState(false)
  const retryContext = useMemo(
    () =>
      retryKey
        ? {
            key: retryKey,
            report: (next: LinkPeekRetryState) => {
              lookup.current = next
              setFailed(next.status === 'failed')
            }
          }
        : null,
    [retryKey]
  )
  // A window resized under an open card can leave the side it opened on without room.
  useEffect(() => {
    if (!open || side !== 'left') {
      return
    }
    let frame = 0
    const place = () => {
      cancelAnimationFrame(frame)
      // After the popover holding the link has moved with the window.
      frame = requestAnimationFrame(() => setPlaced(sideWithRoom(side, trigger.current)))
    }
    window.addEventListener('resize', place)
    return () => {
      cancelAnimationFrame(frame)
      window.removeEventListener('resize', place)
    }
  }, [open, side])
  const pendingOpen = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const cancelPendingOpen = () => clearTimeout(pendingOpen.current)
  useEffect(() => () => clearTimeout(pendingOpen.current), [])
  const scheduleOpen = () => {
    cancelPendingOpen()
    pendingOpen.current = setTimeout(() => {
      setPlaced(sideWithRoom(side, trigger.current))
      setOpen(true)
    }, 350)
  }
  const dismiss = () => {
    cancelPendingOpen()
    setOpen(false)
  }
  return (
    <HoverCard
      open={open}
      onOpenChange={(next) => {
        // Only our cancelable intent may open; Radix retains closing and card traversal.
        if (!next && open) {
          dismiss()
        }
      }}
      openDelay={0}
      closeDelay={120}
    >
      <HoverCardTrigger
        asChild
        onPointerEnter={(event) => {
          if (!open) {
            event.preventDefault()
            if (event.pointerType !== 'touch' && event.buttons === 0) {
              scheduleOpen()
            }
          }
        }}
        onPointerLeave={cancelPendingOpen}
        onPointerDown={dismiss}
        onContextMenu={dismiss}
        onFocus={(event) => {
          const keyboardFocus =
            event.target instanceof Element && event.target.matches(':focus-visible')
          if (!open || !keyboardFocus) {
            event.preventDefault()
          }
          if (!open && keyboardFocus) {
            scheduleOpen()
          }
        }}
        onBlur={cancelPendingOpen}
      >
        {/* A click opens the link (or its action popover); the peek must not sit on top of it. */}
        <span
          ref={trigger}
          onClickCapture={dismiss}
          onAuxClickCapture={(event) => {
            if (event.button === 1) {
              dismiss()
            }
          }}
          onKeyDown={(event) => {
            const state = lookup.current
            if (
              !retryKey ||
              event.key.toLowerCase() !== retryKey ||
              event.altKey ||
              event.ctrlKey ||
              event.metaKey
            ) {
              return
            }
            // A press the card took stays the card's through its last repeat, even once the retry
            // has answered; otherwise the repeats would type into the item's draft.
            const held = retryKeyHeld.current && event.repeat
            if (state.status === 'idle' && !held) {
              return
            }
            // The key is the card's while it has failed or is retrying: it must not reach the page
            // (the item pane types it into its draft). A held key retries once, not on every repeat.
            event.preventDefault()
            event.stopPropagation()
            if (!event.repeat) {
              retryKeyHeld.current = true
            }
            if (state.status === 'failed' && !event.repeat) {
              state.retry()
            }
          }}
          onKeyUp={(event) => {
            if (retryKey && event.key.toLowerCase() === retryKey) {
              retryKeyHeld.current = false
            }
          }}
          onBlur={() => {
            retryKeyHeld.current = false
          }}
        >
          {children}
          {retryKey ? (
            <span className="sr-only" aria-live="polite">
              {failed
                ? t(
                    'components.native-chat.githubPeek.retryKeyHint',
                    'Preview unavailable. Press {{key}} to retry.',
                    { key: retryKey.toUpperCase() }
                  )
                : ''}
            </span>
          ) : null}
        </span>
      </HoverCardTrigger>
      {/* Never wider or taller than the window, with a margin, even at the largest zoom: what does not
          fit scrolls. */}
      <HoverCardContent
        side={placed}
        align="start"
        sideOffset={CARD_OFFSET}
        collisionPadding={WINDOW_MARGIN}
        className={cn(
          'flex max-h-(--radix-hover-card-content-available-height) w-96 max-w-[calc(100vw-1rem)] flex-col',
          // Over the popover the link is listed in (popovers sit at 60).
          overPopover && 'z-[70]'
        )}
      >
        <div className="scrollbar-sleek min-h-0 overflow-y-auto">
          <LinkPeekRetryContext value={retryContext}>{body}</LinkPeekRetryContext>
        </div>
      </HoverCardContent>
    </HoverCard>
  )
}
