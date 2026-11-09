import React from 'react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/utils'
import type { CloudWorkspacePresence } from '../../../../shared/cloud-workspaces/cloud-workspaces-wire'
import {
  initials,
  memberHue,
  memberName,
  presenceSummary,
  presentMembers,
  type MemberDirectory
} from './cloud-workspace-format'

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
        size === 'sm' ? 'size-5 text-[9px]' : 'size-6 text-[10px]',
        className
      )}
      style={hueStyle}
    >
      {initials(label)}
    </span>
  )
}

/**
 * Who is in the workspace right now, one avatar per member. A teammate's avatar is a button that
 * follows them (opens the workspace on the chat they have in front).
 */
export function PresenceStack({
  presence,
  directory,
  selfId,
  onFollow,
  max = 3
}: {
  presence: CloudWorkspacePresence[]
  directory: MemberDirectory
  selfId: string | null
  onFollow?: (member: CloudWorkspacePresence) => void
  max?: number
}): React.JSX.Element | null {
  const t = useTranslate()
  const members = presentMembers(presence, selfId)
  if (members.length === 0) {
    return null
  }
  const shown = members.slice(0, max)
  const extra = members.length - shown.length
  const summary = presenceSummary(members, directory, selfId, t)
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="flex items-center -space-x-1.5">
          {/* Viewing is the avatar alone; typing rings it and adds a pulsing dot. Neither reuses
              the workspace status colors, so presence never reads as "running" or "failed". */}
          {shown.map((p) => {
            const avatar = (
              <>
                <MemberAvatar userId={p.userId} directory={directory} selfId={selfId} size="sm" />
                {p.state === 'typing' && (
                  <span className="absolute -bottom-0.5 -right-0.5 size-2 rounded-full bg-primary ring-2 ring-background motion-safe:animate-pulse" />
                )}
              </>
            )
            return onFollow && p.userId !== selfId ? (
              <button
                key={p.userId}
                type="button"
                onClick={() => onFollow(p)}
                aria-label={t('auto.components.cloudWorkspaces.followMember', 'Follow {{value0}}', {
                  value0: memberName(directory, p.userId, selfId, t)
                })}
                className="relative cursor-default rounded-full ring-2 ring-background outline-none focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
              >
                {avatar}
              </button>
            ) : (
              <span
                key={p.userId}
                role="img"
                aria-label={presenceSummary([p], directory, selfId, t)}
                className="relative rounded-full ring-2 ring-background"
              >
                {avatar}
              </span>
            )
          })}
          {extra > 0 && (
            <span className="relative inline-flex size-5 items-center justify-center rounded-full bg-muted text-[9px] font-medium text-muted-foreground ring-2 ring-background">
              +{extra}
            </span>
          )}
        </span>
      </TooltipTrigger>
      <TooltipContent side="top">{summary}</TooltipContent>
    </Tooltip>
  )
}
