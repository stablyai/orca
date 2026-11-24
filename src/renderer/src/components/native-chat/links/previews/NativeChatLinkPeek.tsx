import { useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card'
import { NativeChatGitHubPeekBody, resolveGitHubPeekLink } from './NativeChatGitHubLinkPeek'
import { NativeChatWebPeekBody } from './NativeChatWebLinkPeek'
import { NativeChatLinkPeekContext } from './native-chat-link-peek-context'
import { previewableWebUrl } from './native-chat-web-link-preview'
import { parseGitHubIssueOrPRLink } from '../../../../../../shared/github/repositories/links'

/** Hover or focus a link to preview it: PRs and issues on its repo's GitHub host, or what a web page says about itself. */
export function NativeChatLinkPeek({
  href,
  githubFallback,
  githubFailedFallback,
  githubChecks,
  side = 'top',
  children
}: {
  href: string | undefined
  /** Where the card opens; it flips when there is no room. */
  side?: 'top' | 'bottom'
  /** What a GitHub card shows until its details arrive, and if they never do, in place of the web
   *  page preview or the failure line: for a caller that already knows the item. */
  githubFallback?: ReactNode
  /** What a GitHub card shows above its failure line if the lookup fails, instead of `githubFallback`:
   *  only what stays true, so a failed card never passes off a known state as current. */
  githubFailedFallback?: ReactNode
  /** A PR's CI result as the caller knows it, beside the GitHub card's state badge. */
  githubChecks?: ReactNode
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
          checks={githubChecks}
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
          checks={githubChecks}
        />
      )
    }
    return webBody
  }, [
    githubChecks,
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
    <LinkPeekCard body={body} side={side}>
      {children}
    </LinkPeekCard>
  )
}

function LinkPeekCard({
  body,
  side,
  children
}: {
  body: ReactNode
  side: 'top' | 'bottom'
  children: ReactNode
}): ReactNode {
  const [open, setOpen] = useState(false)
  const pendingOpen = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const cancelPendingOpen = () => clearTimeout(pendingOpen.current)
  useEffect(() => () => clearTimeout(pendingOpen.current), [])
  const scheduleOpen = () => {
    cancelPendingOpen()
    pendingOpen.current = setTimeout(() => setOpen(true), 350)
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
          onClickCapture={dismiss}
          onAuxClickCapture={(event) => {
            if (event.button === 1) {
              dismiss()
            }
          }}
        >
          {children}
        </span>
      </HoverCardTrigger>
      {/* Never wider than the window, with a margin, even at the largest zoom. */}
      <HoverCardContent
        side={side}
        align="start"
        collisionPadding={8}
        className="w-96 max-w-[calc(100vw-1rem)]"
      >
        {body}
      </HoverCardContent>
    </HoverCard>
  )
}
