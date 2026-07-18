import { useState } from 'react'
import { cn } from '@/lib/utils'
import { githubAvatarUrl } from '@/components/github/github-issue-comment-helpers'

/**
 * Build a 1-2 character initials placeholder from a display name or login,
 * used when no avatar image is available or the image fails to load.
 */
function initialsFor(login: string, name?: string | null): string {
  const source = (name?.trim() || login).trim()
  if (!source) {
    return '?'
  }
  // Iterate by code point (not UTF-16 unit) and keep only letters/digits, so a
  // display name that leads with an emoji or other non-BMP char yields clean
  // initials instead of a broken surrogate half. Words that are all symbols are
  // skipped; an all-symbol name falls back to '?'.
  const alnum = (word: string): string[] => [...word].filter((ch) => /[\p{L}\p{N}]/u.test(ch))
  const parts = source.split(/\s+/).filter(Boolean)
  const letters =
    parts.length >= 2
      ? parts
          .map((word) => alnum(word)[0])
          .filter(Boolean)
          .slice(0, 2)
          .join('')
      : alnum(source).slice(0, 2).join('')
  return letters.toUpperCase() || '?'
}

/**
 * Prefer the API `avatar_url`, then the public login.png URL. Empty/whitespace
 * API values and empty logins never produce a bogus request. See #8784.
 */
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
