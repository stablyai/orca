import React from 'react'

function isGitHubUserAttachmentUrl(href: string | undefined): href is string {
  if (!href) {
    return false
  }
  try {
    const url = new URL(href)
    return (
      url.protocol === 'https:' &&
      url.hostname === 'github.com' &&
      url.pathname.startsWith('/user-attachments/assets/')
    )
  } catch {
    return false
  }
}

function isBareAutolink(children: React.ReactNode, href: string): boolean {
  const text = React.Children.toArray(children).join('').trim()
  return text === href
}

export function isGitHubUserAttachmentVideoLink(
  href: string | undefined,
  children: React.ReactNode
): href is string {
  return isGitHubUserAttachmentUrl(href) && isBareAutolink(children, href)
}

export function GitHubUserAttachmentVideo({
  href,
  children
}: {
  href: string
  children: React.ReactNode
}): React.ReactElement {
  const [failed, setFailed] = React.useState(false)

  if (failed) {
    return (
      <a
        href={href}
        target="_blank"
        rel="noreferrer"
        className="break-all text-primary underline underline-offset-2 hover:text-primary/80"
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </a>
    )
  }

  return (
    <video
      src={href}
      controls
      preload="metadata"
      playsInline
      className="my-3 max-h-[28rem] max-w-full rounded-md bg-black/80 outline outline-1 outline-black/10 dark:outline-white/10"
      onClick={(e) => e.stopPropagation()}
      onError={() => setFailed(true)}
    >
      <a href={href} target="_blank" rel="noreferrer">
        {children}
      </a>
    </video>
  )
}
