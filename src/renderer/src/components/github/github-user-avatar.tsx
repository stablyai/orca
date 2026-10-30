import { useState } from 'react'
import { cn } from '@/lib/utils'
import { initialsFor } from '../../../../shared/user-initials'

function githubAvatarUrl(login: string): string {
  return `https://github.com/${encodeURIComponent(login)}.png?size=64`
}

/** Prefer API avatar URLs for GHES; blank API values/logins must not create bogus requests. */
export function resolveGitHubUserAvatarSrc(
  login: string,
  avatarUrl?: string | null
): string | null {
  const fromApi = avatarUrl?.trim()
  if (fromApi) {
    return fromApi
  }
  const trimmedLogin = login.trim()
  if (!trimmedLogin) {
    return null
  }
  return githubAvatarUrl(trimmedLogin)
}

export function GitHubUserAvatar({
  login,
  name,
  avatarUrl,
  title,
  className
}: {
  login: string
  name?: string | null
  avatarUrl?: string | null
  title?: string
  className?: string
}): React.JSX.Element {
  // Track the failed URL so late detail enrichment can retry a GHES avatar after the public-login fallback fails.
  const [failedSrc, setFailedSrc] = useState<string | null>(null)
  const src = resolveGitHubUserAvatarSrc(login, avatarUrl)
  if (src && failedSrc !== src) {
    return (
      <img
        src={src}
        alt=""
        loading="lazy"
        decoding="async"
        title={title}
        onError={() => setFailedSrc(src)}
        className={cn(
          'shrink-0 rounded-full border border-border/50 bg-muted object-cover',
          className
        )}
      />
    )
  }
  return (
    <span
      title={title}
      aria-hidden
      className={cn(
        'inline-flex shrink-0 items-center justify-center rounded-full border border-border/50 bg-muted text-[10px] font-semibold text-muted-foreground',
        className
      )}
    >
      {initialsFor(login, name)}
    </span>
  )
}
