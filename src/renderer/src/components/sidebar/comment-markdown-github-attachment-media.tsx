import React from 'react'

export function isGitHubUserAttachmentUrl(href: string | undefined): href is string {
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

// Shared fallback link for attachments that can't render inline (see the image
// note below on why load failures drop to a session-scoped link).
function AttachmentFallbackLink({
  href,
  children
}: {
  href: string
  children: React.ReactNode
}): React.ReactElement {
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

export function GitHubUserAttachmentVideo({
  href,
  children
}: {
  href: string
  children: React.ReactNode
}): React.ReactElement {
  const [failed, setFailed] = React.useState(false)

  if (failed) {
    return <AttachmentFallbackLink href={href}>{children}</AttachmentFallbackLink>
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

export function GitHubUserAttachmentImage({
  src,
  alt
}: {
  src: string
  alt: string | undefined
}): React.ReactElement {
  const [failed, setFailed] = React.useState(false)
  const label = alt?.trim() || src

  // Why: private-repo attachment images can't load cross-origin without the
  // user's GitHub session cookies, so wrap in a top-level link (opening the
  // URL where that session exists) and drop to a text link on load error.
  if (failed) {
    return <AttachmentFallbackLink href={src}>{label}</AttachmentFallbackLink>
  }

  return (
    <a
      href={src}
      target="_blank"
      rel="noreferrer"
      className="inline-block max-w-full"
      onClick={(e) => e.stopPropagation()}
    >
      <img
        src={src}
        alt={alt ?? ''}
        className="my-3 max-h-96 max-w-full rounded-md object-contain outline outline-1 outline-black/10 dark:outline-white/10"
        onError={() => setFailed(true)}
      />
    </a>
  )
}
