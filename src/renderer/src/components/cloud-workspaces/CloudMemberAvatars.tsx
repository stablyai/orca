import type React from 'react'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import { initials, memberHue, memberName, type MemberDirectory } from './cloud-workspace-format'

export function MemberAvatar({
  userId,
  directory,
  selfId,
  size = 'md',
  className
}: {
  userId: string
  directory: MemberDirectory
  selfId: string | null
  size?: 'sm' | 'md'
  className?: string
}): React.JSX.Element {
  const t = useTranslate()
  const name = memberName(directory, userId, selfId, t)
  const label =
    userId === selfId
      ? (directory.get(userId)?.name ?? t('auto.components.cloudWorkspaces.you', 'You'))
      : name
  // Per-member hue feeds the hsl() classes below so a teammate keeps one color everywhere.
  const hueStyle: React.CSSProperties & { '--avatar-hue': string } = {
    '--avatar-hue': String(memberHue(userId))
  }
  return (
    <span
      aria-hidden
      className={cn(
        'inline-flex shrink-0 select-none items-center justify-center rounded-full font-medium',
        'bg-[hsl(var(--avatar-hue)_45%_88%)] text-[hsl(var(--avatar-hue)_45%_28%)]',
        'dark:bg-[hsl(var(--avatar-hue)_30%_26%)] dark:text-[hsl(var(--avatar-hue)_55%_82%)]',
        size === 'sm' ? 'size-5 text-3xs' : 'size-6 text-3xs',
        className
      )}
      style={hueStyle}
    >
      {initials(label)}
    </span>
  )
}
