// PARITY-FOLLOW: the sidebar's Following section, under the nav and above Projects, for a team
// account only: teammates' cloud workspaces this member follows; a row opens the workspace, its
// hover action unfollows. (The team list moved to the web console.)
import React, { useCallback, useState } from 'react'
import { ChevronRight, Users, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import { MemberAvatar } from '@/components/cloud-workspaces/CloudMemberAvatars'
import type { MemberDirectory } from '@/components/cloud-workspaces/cloud-workspace-format'

export type SidebarFollowedWorkspace = {
  sandboxId: string
  title: string
  /** W-123, when known. */
  numberLabel: string | null
  creatorId: string
  status: 'running' | 'asleep' | 'waking' | 'archived'
  /** Teammates in it now (not counting this member). */
  hereNow: number
}

/** A section's open state, remembered on this computer for this member. */
export function useSidebarSectionOpen(
  section: 'following',
  selfId: string | null,
  defaultOpen: boolean
): [boolean, () => void] {
  const key = `orca.sidebar.${section}.open:${selfId ?? 'anon'}`
  const [open, setOpen] = useState<boolean>(() => {
    try {
      const stored = window.localStorage.getItem(key)
      return stored === null ? defaultOpen : stored === 'true'
    } catch {
      return defaultOpen
    }
  })
  const toggle = useCallback(() => {
    const next = !open
    setOpen(next)
    try {
      window.localStorage.setItem(key, String(next))
    } catch {
      // Not remembered; the toggle still works for this session.
    }
  }, [key, open])
  return [open, toggle]
}

const ROW =
  'group/team-row flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1 text-left text-[13px] tracking-tight text-worktree-sidebar-foreground/80 hover:bg-worktree-sidebar-foreground/8'

function SectionHeader({
  title,
  count,
  open,
  onToggle
}: {
  title: string
  count: number
  open: boolean
  onToggle: () => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      aria-expanded={open}
      onClick={onToggle}
      className="flex h-7 w-full items-center gap-1 rounded-md px-2 text-left text-xs font-semibold text-muted-foreground/80 hover:text-muted-foreground"
    >
      <ChevronRight
        className={cn('size-3 shrink-0 transition-transform', open && 'rotate-90')}
        aria-hidden
      />
      <span className="min-w-0 flex-1 truncate">{title}</span>
      <span className="text-2xs font-normal tabular-nums text-muted-foreground/60">{count}</span>
    </button>
  )
}

function HoverAction({
  label,
  onClick,
  children
}: {
  label: string
  onClick: () => void
  children: React.ReactNode
}): React.JSX.Element {
  return (
    // Shown on the row's hover or focus; the wrapper owns that, the Button keeps its own look.
    <span className="flex shrink-0 opacity-0 group-hover/team-row:opacity-100 group-focus-within/team-row:opacity-100">
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label={label}
            onClick={(event) => {
              event.stopPropagation()
              onClick()
            }}
          >
            {children}
          </Button>
        </TooltipTrigger>
        <TooltipContent side="top" sideOffset={4}>
          {label}
        </TooltipContent>
      </Tooltip>
    </span>
  )
}

export function SidebarFollowingSection({
  workspaces,
  directory,
  selfId,
  defaultOpen = true,
  onOpen,
  onUnfollow
}: {
  workspaces: SidebarFollowedWorkspace[]
  directory: MemberDirectory
  selfId: string | null
  defaultOpen?: boolean
  onOpen: (sandboxId: string) => void
  onUnfollow: (sandboxId: string) => void
}): React.JSX.Element | null {
  const t = useTranslate()
  const [open, toggle] = useSidebarSectionOpen('following', selfId, defaultOpen)
  // Nothing followed: no section (Follow lives on the workspace, beside its W-123).
  if (workspaces.length === 0) {
    return null
  }
  const statusWord = (s: SidebarFollowedWorkspace['status']): string | null =>
    s === 'asleep'
      ? t('sidebarFollowing.asleep', 'Asleep')
      : s === 'waking'
        ? t('sidebarFollowing.waking', 'Waking')
        : s === 'archived'
          ? t('sidebarFollowing.archived', 'Archived')
          : null
  return (
    <section aria-label={t('sidebarFollowing.title', 'Following')} className="flex flex-col px-2">
      <SectionHeader
        title={t('sidebarFollowing.title', 'Following')}
        count={workspaces.length}
        open={open}
        onToggle={toggle}
      />
      {open ? (
        <ul className="flex flex-col gap-px pb-1">
          {workspaces.map((w) => {
            const word = statusWord(w.status)
            return (
              <li key={w.sandboxId}>
                <div
                  role="button"
                  tabIndex={0}
                  className={cn(ROW, w.status === 'archived' && 'opacity-60')}
                  onClick={() => onOpen(w.sandboxId)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault()
                      onOpen(w.sandboxId)
                    }
                  }}
                >
                  <MemberAvatar
                    userId={w.creatorId}
                    directory={directory}
                    selfId={selfId}
                    size="sm"
                  />
                  <span className="min-w-0 flex-1 truncate">{w.title}</span>
                  {w.hereNow > 0 ? (
                    <span
                      className="shrink-0 text-2xs tabular-nums text-muted-foreground group-hover/team-row:hidden"
                      aria-label={t('sidebarFollowing.hereNow', '{{count}} here now', {
                        count: w.hereNow
                      })}
                    >
                      <Users className="mr-0.5 inline size-3 align-[-2px]" aria-hidden />
                      {w.hereNow}
                    </span>
                  ) : null}
                  {word ? (
                    <span className="shrink-0 text-2xs text-muted-foreground group-hover/team-row:hidden">
                      {word}
                    </span>
                  ) : null}
                  {w.numberLabel ? (
                    <span className="shrink-0 font-mono text-2xs tabular-nums text-muted-foreground/70 group-hover/team-row:hidden">
                      {w.numberLabel}
                    </span>
                  ) : null}
                  <HoverAction
                    label={t('cloudFollow.unfollowNamed', 'Unfollow {{title}}', { title: w.title })}
                    onClick={() => onUnfollow(w.sandboxId)}
                  >
                    <X className="size-3.5" aria-hidden />
                  </HoverAction>
                </div>
              </li>
            )
          })}
        </ul>
      ) : null}
    </section>
  )
}
