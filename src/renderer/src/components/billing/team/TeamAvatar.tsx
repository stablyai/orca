import { useState } from 'react'
import { cn } from '@/lib/utils'

/**
 * A teammate's provider profile picture filling its avatar circle, or null when there is none or it
 * failed to load (the caller's initials show instead). No referrer goes to the image host.
 */
export function ProfilePicture({
  url,
  className
}: {
  url: string | undefined
  className?: string
}): React.JSX.Element | null {
  const [failed, setFailed] = useState<string | null>(null)
  if (!url || failed === url) {
    return null
  }
  return (
    <img
      src={url}
      alt=""
      referrerPolicy="no-referrer"
      draggable={false}
      onError={() => setFailed(url)}
      className={cn('absolute inset-0 size-full rounded-full object-cover', className)}
    />
  )
}

/** "Ada Lovelace" → "AL", "ada@x.io" → "A", "Acme Dev" → "AD". */
export function initialsFor(nameOrEmail: string): string {
  const base = nameOrEmail.includes('@') ? (nameOrEmail.split('@')[0] ?? '') : nameOrEmail
  const words = base
    .split(/[\s._-]+/)
    .map((word) => word.trim())
    .filter(Boolean)
  if (words.length === 0) {
    return '?'
  }
  const first = words[0]!.charAt(0)
  const second = !nameOrEmail.includes('@') && words.length > 1 ? words[1]!.charAt(0) : ''
  return (first + second).toUpperCase()
}

/** Round person avatar (picture, else initials). Pending people get a dashed, hollow look. */
export function PersonAvatar({
  name,
  pending = false,
  pictureUrl,
  className
}: {
  name: string
  pending?: boolean
  pictureUrl?: string
  className?: string
}): React.JSX.Element {
  return (
    <span
      aria-hidden
      className={cn(
        'relative flex size-6 shrink-0 items-center justify-center overflow-hidden rounded-full text-[10px] font-medium select-none',
        pending
          ? 'border border-dashed border-muted-foreground/50 text-muted-foreground'
          : 'border border-border bg-secondary text-secondary-foreground',
        className
      )}
    >
      {initialsFor(name)}
      {pending ? null : <ProfilePicture url={pictureUrl} />}
    </span>
  )
}

/** Rounded-square team mark, distinct from people's round avatars. */
export function TeamMark({
  name,
  className
}: {
  name: string
  className?: string
}): React.JSX.Element {
  return (
    <span
      aria-hidden
      className={cn(
        'flex size-10 shrink-0 items-center justify-center rounded-lg border border-border bg-gradient-to-br from-muted to-background text-sm font-semibold text-foreground shadow-xs select-none',
        className
      )}
    >
      {initialsFor(name)}
    </span>
  )
}
