import { cn } from '@/lib/utils'
import type { OdooUser } from '../../../shared/odoo-types'
function initials(name: string): string {
  const trimmed = name.trim()
  return trimmed ? trimmed.slice(0, 1).toUpperCase() : '?'
}

/** Odoo user/author avatar: the `avatar_128` image when present, else initials. */
export function OdooUserAvatar({
  user,
  className
}: {
  user: Pick<OdooUser, 'displayName' | 'avatarUrl'>
  className?: string
}): React.JSX.Element {
  const base = cn('size-5 shrink-0 rounded-full', className)
  if (user.avatarUrl) {
    return (
      <img
        src={user.avatarUrl}
        alt={user.displayName}
        title={user.displayName}
        className={cn(base, 'object-cover ring-1 ring-border/50')}
      />
    )
  }
  return (
    <span
      title={user.displayName}
      className={cn(
        base,
        'flex items-center justify-center border border-border/50 bg-muted/50 text-[10px] font-medium text-muted-foreground'
      )}
    >
      {initials(user.displayName)}
    </span>
  )
}
