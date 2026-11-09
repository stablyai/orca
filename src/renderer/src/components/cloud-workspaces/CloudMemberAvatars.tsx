import React from 'react'
import { ArrowUpRight } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useIntlLocale, useTranslate } from '@/i18n/use-translate'
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
        size === 'sm' ? 'size-5 text-3xs' : 'size-6 text-3xs',
        className
      )}
      style={hueStyle}
    >
      {initials(label)}
    </span>
  )
}

/**
 * Who is in the workspace right now, one avatar per member, each with its own tooltip. A
 * teammate's avatar is a button that jumps once to the chat they have in front.
 */
export function PresenceStack({
  presence,
  directory,
  selfId,
  onGoToChat,
  max = 3
}: {
  presence: CloudWorkspacePresence[]
  directory: MemberDirectory
  selfId: string | null
  onGoToChat?: (member: CloudWorkspacePresence) => void
  max?: number
}): React.JSX.Element | null {
  const t = useTranslate()
  const intlLocale = useIntlLocale()
  const members = presentMembers(presence, selfId)
  if (members.length === 0) {
    return null
  }
  const shown = members.slice(0, max)
  const extra = members.length - shown.length
  return (
    <span className="flex items-center -space-x-1">
      {/* Viewing is the avatar alone; typing adds a pulsing dot. Neither reuses the workspace
          status colors, so presence never reads as "running" or "failed". */}
      {shown.map((p) => {
        const status = presenceSummary([p], directory, selfId, t, intlLocale)
        const avatar = (
          <>
            <MemberAvatar userId={p.userId} directory={directory} selfId={selfId} size="md" />
            {p.state === 'typing' && (
              <span className="absolute -bottom-0.5 -right-0.5 z-10 size-2 rounded-full bg-agent-working ring-2 ring-background motion-safe:animate-pulse" />
            )}
          </>
        )
        if (!onGoToChat || p.userId === selfId) {
          return (
            <Tooltip key={p.userId}>
              <TooltipTrigger asChild>
                <span
                  role="img"
                  aria-label={status}
                  className="relative rounded-full ring-2 ring-background"
                >
                  {avatar}
                </span>
              </TooltipTrigger>
              <TooltipContent side="top">{status}</TooltipContent>
            </Tooltip>
          )
        }
        const goTo = t('auto.components.cloudWorkspaces.goToChat', "Go to {{value0}}'s chat", {
          value0: memberName(directory, p.userId, selfId, t)
        })
        return (
          <Tooltip key={p.userId}>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={() => onGoToChat(p)}
                aria-label={goTo}
                className="relative cursor-default rounded-full ring-2 ring-background outline-none focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
              >
                {avatar}
              </button>
            </TooltipTrigger>
            <TooltipContent side="top">
              <span className="flex items-center gap-1">
                <ArrowUpRight className="size-3" aria-hidden />
                {goTo}
              </span>
              <span className="block opacity-80">{status}</span>
            </TooltipContent>
          </Tooltip>
        )
      })}
      {extra > 0 && (
        <span className="relative inline-flex size-6 items-center justify-center rounded-full bg-muted text-3xs font-medium text-muted-foreground ring-2 ring-background">
          <span aria-hidden>+{extra}</span>
          <span className="sr-only">
            {t('auto.components.cloudWorkspaces.moreMembers', '{{count}} more', { count: extra })}
          </span>
        </span>
      )}
    </span>
  )
}
