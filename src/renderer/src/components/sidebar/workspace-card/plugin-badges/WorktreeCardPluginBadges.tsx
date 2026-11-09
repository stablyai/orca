import type React from 'react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import type { ActivePluginWorktreeBadge } from '@/store/plugins/worktree-badges/plugin-worktree-badges'
import { PluginWorktreeBadgeIcon } from './PluginWorktreeBadgeIcon'
import { PluginWorktreeBadgeCommandItems } from './WorktreePluginBadgeMenuItems'
import {
  useMatchingPluginWorktreeBadges,
  type PluginBadgeRepo,
  type PluginBadgeWorktree
} from './use-matching-plugin-worktree-badges'

type BadgeProps = {
  worktreeId: string
  onPointerDown: React.PointerEventHandler<HTMLButtonElement>
}

function WorktreeCardPluginBadge({
  badge,
  worktreeId,
  onPointerDown
}: BadgeProps & { badge: ActivePluginWorktreeBadge }): React.JSX.Element {
  return (
    <DropdownMenu modal={false}>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              data-worktree-card-plugin-badge={badge.key}
              aria-label={badge.title}
              onPointerDown={onPointerDown}
              onKeyDown={(event) => {
                // Why: the sidebar treats a bubbled Enter as "focus the terminal".
                if (event.key === 'Enter' || event.key === ' ') {
                  event.stopPropagation()
                }
              }}
              // Why: opening the badge menu and activating the workspace are separate intents.
              onClick={(event) => event.stopPropagation()}
              className="inline-flex size-4 shrink-0 items-center justify-center rounded bg-transparent text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:bg-accent focus-visible:text-foreground focus-visible:outline-none data-[state=open]:bg-accent data-[state=open]:text-foreground"
            >
              <PluginWorktreeBadgeIcon icon={badge.icon} className="size-3" />
            </button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent side="right" sideOffset={8}>
          {badge.title}
        </TooltipContent>
      </Tooltip>
      {/* Why: React events bubble through portals, so menu clicks must not reach the card. */}
      <DropdownMenuContent
        align="start"
        className="w-52"
        onClick={(event) => event.stopPropagation()}
      >
        <DropdownMenuLabel>{badge.title}</DropdownMenuLabel>
        <PluginWorktreeBadgeCommandItems badge={badge} worktreeId={worktreeId} />
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** Plugin badges beside the workspace name; each opens a menu of the plugin's workspace commands. */
export function WorktreeCardPluginBadges({
  worktree,
  repo,
  isActive,
  onPointerDown
}: Pick<BadgeProps, 'onPointerDown'> & {
  worktree: PluginBadgeWorktree
  repo: PluginBadgeRepo
  isActive: boolean
}): React.JSX.Element | null {
  const badges = useMatchingPluginWorktreeBadges(worktree, repo, isActive)
  if (badges.length === 0) {
    return null
  }
  return (
    <>
      {badges.map((badge) => (
        <WorktreeCardPluginBadge
          key={badge.key}
          badge={badge}
          worktreeId={worktree.id}
          onPointerDown={onPointerDown}
        />
      ))}
    </>
  )
}
