import { useState } from 'react'
import { cn } from '@/lib/utils'
import { githubAvatarUrl } from '@/components/github/github-issue-comment-helpers'

function initialsFor(login: string, name?: string | null): string {
  const source = (name?.trim() || login).trim()
  if (!source) {
    return '?'
  }
  const parts = source.split(/\s+/).filter(Boolean)
  const letters = parts.length >= 2 ? `${parts[0][0]}${parts[1][0]}` : source.slice(0, 2)
  return letters.toUpperCase()
}

/**
 * Avatar for a GitHub user that renders correctly on github.com and GitHub
 * Enterprise. GHE logins don't exist on github.com, so the login-based
 * `github.com/{login}.png` URL 404s. We prefer the API-provided `avatarUrl`
 * and, when it (or the login fallback) fails to load, degrade to an initials
 * placeholder instead of a broken image. See #8784.
 */
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
  // Why: track the specific src that failed rather than a boolean. Avatar data
  // arrives after the first paint (PR detail enrichment), so a row that 404s on
  // the early login-based URL must retry once the real avatar_url lands — a
  // latched boolean would keep showing the placeholder forever. See #8784.
  const [failedSrc, setFailedSrc] = useState<string | null>(null)
  const src = avatarUrl || githubAvatarUrl(login)
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
