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
  children
}: {
  href: string | undefined
  children: ReactNode
}): ReactNode {
  const { githubRepo, githubRoutingHostId, webPreviews } = useContext(NativeChatLinkPeekContext)
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
          otherRepoFallback={github.ownRepo ? undefined : webBody}
        />
      )
    }
    // No chat repo on the link's host, as in a folder workspace: another repo on the chat's host
    // can still answer with its GitHub sign-in. A web page fetch can't read private repos.
    const routed = href && githubRoutingHostId ? parseGitHubIssueOrPRLink(href) : null
    if (routed && githubRoutingHostId) {
      return (
        <NativeChatGitHubPeekBody
          key={`routed:${githubRoutingHostId}:${href}`}
          source={{ kind: 'routed', hostId: githubRoutingHostId }}
          link={routed}
          otherRepoFallback={webBody}
        />
      )
    }
    return webBody
  }, [githubRepo, githubRoutingHostId, href, webPreviews])
  if (!body) {
    return children
  }
  return <LinkPeekCard body={body}>{children}</LinkPeekCard>
}

function LinkPeekCard({ body, children }: { body: ReactNode; children: ReactNode }): ReactNode {
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
      <HoverCardContent side="top" align="start" className="w-96">
        {body}
      </HoverCardContent>
    </HoverCard>
  )
}
