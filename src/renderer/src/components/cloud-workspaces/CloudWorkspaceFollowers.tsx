// PARITY-FOLLOW: who is on a cloud workspace, beside its W-123 chip in the top bar. The creator
// comes first, then the people following it, then anyone else looking at it now. Someone viewing
// gets a ring in their own color; typing adds the pulsing dot the picker rows use. "Follow" keeps a
// teammate's workspace in the sidebar's Following section until it is unfollowed.
import React from 'react'
import { Check, Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import type { CloudWorkspacePresence } from '../../../../shared/cloud-workspaces/cloud-workspaces-wire'
import { MemberAvatar } from './CloudMemberAvatars'
import { memberHue, memberName, type MemberDirectory } from './cloud-workspace-format'

export type WorkspaceFollowerRole = 'creator' | 'follower' | 'visitor'

export type WorkspaceFollowerEntry = {
  userId: string
  role: WorkspaceFollowerRole
  /** Live presence on this workspace now, or null. */
  state: 'viewing' | 'typing' | null
}

/** Creator, then followers (oldest follow first), then present visitors; each member once. */
export function workspaceFollowerEntries(args: {
  creatorId: string
  followers: readonly string[]
  presence: readonly CloudWorkspacePresence[]
}): WorkspaceFollowerEntry[] {
  const live = new Map<string, 'viewing' | 'typing'>()
  for (const p of args.presence) {
    // A member typing on one device and viewing on another reads as typing.
    if (live.get(p.userId) !== 'typing') {
      live.set(p.userId, p.state)
    }
  }
  const seen = new Set<string>()
  const out: WorkspaceFollowerEntry[] = []
  const add = (userId: string, role: WorkspaceFollowerRole): void => {
    if (!seen.has(userId)) {
      seen.add(userId)
      out.push({ userId, role, state: live.get(userId) ?? null })
    }
  }
  add(args.creatorId, 'creator')
  for (const id of args.followers) {
    add(id, 'follower')
  }
  for (const id of live.keys()) {
    add(id, 'visitor')
  }
  return out
}

function entryLabel(
  entry: WorkspaceFollowerEntry,
  name: string,
  t: ReturnType<typeof useTranslate>
): string {
  const role =
    entry.role === 'creator'
      ? t('cloudFollow.role.creator', 'Created this workspace')
      : entry.role === 'follower'
        ? t('cloudFollow.role.follower', 'Following')
        : null
  const now =
    entry.state === 'typing'
      ? t('cloudFollow.state.typing', 'Typing now')
      : entry.state === 'viewing'
        ? t('cloudFollow.state.viewing', 'Here now')
        : null
  return [name, role, now].filter(Boolean).join(' · ')
}

export function CloudWorkspaceFollowers({
  entries,
  directory,
  selfId,
  following,
  busy = false,
  onToggleFollow,
  onOpenMember,
  max = 3
}: {
  entries: WorkspaceFollowerEntry[]
  directory: MemberDirectory
  selfId: string | null
  /** Null hides Follow: the creator's own workspace, or a control plane without follows. */
  following: boolean | null
  busy?: boolean
  onToggleFollow?: () => void
  /** Opens the teammate's profile. */
  onOpenMember?: (userId: string) => void
  max?: number
}): React.JSX.Element | null {
  const t = useTranslate()
  const others = entries.filter((e) => e.userId !== selfId || e.role === 'creator')
  if (others.length === 0 && following === null) {
    return null
  }
  const shown = others.slice(0, max)
  const extra = others.length - shown.length
  return (
    <div className="mr-1 flex items-center gap-1.5 [-webkit-app-region:no-drag] max-[960px]:hidden">
      <span
        role="group"
        aria-label={t('cloudFollow.stackLabel', 'People on this workspace')}
        className="flex items-center -space-x-1"
      >
        {shown.map((entry) => {
          const name = memberName(directory, entry.userId, selfId, t)
          const label = entryLabel(entry, name, t)
          const ring: React.CSSProperties & { '--avatar-hue': string } = {
            '--avatar-hue': String(memberHue(entry.userId))
          }
          return (
            <Tooltip key={entry.userId}>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  aria-label={label}
                  data-follower-role={entry.role}
                  data-follower-state={entry.state ?? 'away'}
                  onClick={onOpenMember ? () => onOpenMember(entry.userId) : undefined}
                  style={ring}
                  className={cn(
                    'relative cursor-default rounded-full ring-2 ring-background outline-none focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-focus-ring',
                    // Here now: a ring in the member's own color. Away stays full strength
                    // (a faded creator reads as gone); the tooltip says it in words.
                    entry.state &&
                      'ring-[hsl(var(--avatar-hue)_55%_55%)] dark:ring-[hsl(var(--avatar-hue)_50%_60%)]'
                  )}
                >
                  <MemberAvatar userId={entry.userId} directory={directory} selfId={selfId} />
                  {entry.state === 'typing' ? (
                    <span className="absolute -bottom-0.5 -right-0.5 z-10 size-2 rounded-full bg-agent-working ring-2 ring-background motion-safe:animate-pulse" />
                  ) : null}
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom" sideOffset={6}>
                {label}
              </TooltipContent>
            </Tooltip>
          )
        })}
        {extra > 0 ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <span
                tabIndex={0}
                className="relative inline-flex size-6 items-center justify-center rounded-full bg-muted text-3xs font-medium text-muted-foreground ring-2 ring-background outline-none focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-focus-ring"
              >
                <span aria-hidden>+{extra}</span>
                <span className="sr-only">
                  {t('auto.components.cloudWorkspaces.moreMembers', '{{count}} more', {
                    count: extra
                  })}
                </span>
              </span>
            </TooltipTrigger>
            {/* The full list, so the cap never hides who is here. */}
            <TooltipContent side="bottom" sideOffset={6}>
              {others.slice(max).map((entry) => (
                <div key={entry.userId}>
                  {entryLabel(entry, memberName(directory, entry.userId, selfId, t), t)}
                </div>
              ))}
            </TooltipContent>
          </Tooltip>
        ) : null}
      </span>
      {following !== null && onToggleFollow ? (
        <Button
          type="button"
          variant={following ? 'ghost' : 'outline'}
          size="xs"
          aria-pressed={following}
          disabled={busy}
          onClick={onToggleFollow}
          className="group/follow"
        >
          {following ? (
            <>
              <Check className="size-3 group-hover/follow:hidden" aria-hidden />
              <span className="group-hover/follow:hidden">
                {t('cloudFollow.following', 'Following')}
              </span>
              <span className="hidden group-hover/follow:inline">
                {t('cloudFollow.unfollow', 'Unfollow')}
              </span>
            </>
          ) : (
            <>
              <Plus className="size-3" aria-hidden />
              {t('cloudFollow.follow', 'Follow')}
            </>
          )}
        </Button>
      ) : null}
    </div>
  )
}
