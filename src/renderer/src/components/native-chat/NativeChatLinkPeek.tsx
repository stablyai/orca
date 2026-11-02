import { useContext, useMemo, useState, type ReactNode } from 'react'
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card'
import { NativeChatGitHubPeekBody, resolveGitHubPeekLink } from './NativeChatGitHubLinkPeek'
import { NativeChatWebPeekBody } from './NativeChatWebLinkPeek'
import { NativeChatLinkPeekContext } from './native-chat-link-peek-context'
import { previewableWebUrl } from './native-chat-web-link-preview'

/** Hover or focus a link to preview it: its own repo's PRs and issues, or what a web page says about itself. */
export function NativeChatLinkPeek({
  href,
  children
}: {
  href: string | undefined
  children: ReactNode
}): ReactNode {
  const { githubRepo, webPreviews } = useContext(NativeChatLinkPeekContext)
  const [open, setOpen] = useState(false)
  const body = useMemo(() => {
    const githubLink = href ? resolveGitHubPeekLink(githubRepo, href) : null
    if (githubRepo && githubLink) {
      return <NativeChatGitHubPeekBody key={href} repo={githubRepo.repo} link={githubLink} />
    }
    const webUrl = webPreviews ? previewableWebUrl(href) : null
    return webUrl ? (
      <NativeChatWebPeekBody
        key={webUrl}
        url={webUrl}
        runtimeEnvironmentId={webPreviews?.runtimeEnvironmentId ?? null}
      />
    ) : null
  }, [githubRepo, href, webPreviews])
  if (!body) {
    return children
  }
  return (
    <HoverCard open={open} onOpenChange={setOpen} openDelay={350} closeDelay={120}>
      <HoverCardTrigger asChild>
        {/* A click opens the link (or its action popover); the peek must not sit on top of it. */}
        <span onClickCapture={() => setOpen(false)}>{children}</span>
      </HoverCardTrigger>
      <HoverCardContent side="top" align="start" className="w-96">
        {body}
      </HoverCardContent>
    </HoverCard>
  )
}
