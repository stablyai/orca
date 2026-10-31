import { useState } from 'react'
import { Users } from 'lucide-react'
import { cn } from '@/lib/utils'
import { isGitHubTeamReviewerLogin } from '../../../../shared/github/pr-reviewer-display'

function githubAvatarUrl(login: string): string {
  return `https://github.com/${encodeURIComponent(login)}.png?size=64`
}

function initialsFor(login: string, name?: string | null): string {
  const source = (name?.trim() || login).trim()
  if (!source) {
    return '?'
  }
  // Iterate Unicode code points and skip symbols so emoji cannot produce broken surrogate initials.
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
  if (isGitHubTeamReviewerLogin(login)) {
    return (
      <span
        title={title}
        aria-hidden
        className={cn(
          'inline-flex shrink-0 items-center justify-center rounded-full border border-border/50 bg-muted text-muted-foreground',
          className
        )}
      >
        <Users className="size-3" />
      </span>
    )
  }
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
