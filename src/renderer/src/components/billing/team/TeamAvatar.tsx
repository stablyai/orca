import { cn } from '@/lib/utils'

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

/** Round person avatar (initials). Pending people get a dashed, hollow look. */
export function PersonAvatar({
  name,
  pending = false,
  className
}: {
  name: string
  pending?: boolean
  className?: string
}): React.JSX.Element {
  return (
    <span
      aria-hidden
      className={cn(
        'flex size-8 shrink-0 items-center justify-center rounded-full text-[11px] font-medium select-none',
        pending
          ? 'border border-dashed border-muted-foreground/50 text-muted-foreground'
          : 'bg-foreground/85 text-background',
        className
      )}
    >
      {initialsFor(name)}
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
