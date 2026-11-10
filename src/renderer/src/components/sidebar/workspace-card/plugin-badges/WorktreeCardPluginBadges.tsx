import type React from 'react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { PluginWorktreeBadgeIcon } from './PluginWorktreeBadgeIcon'
import {
  PluginWorktreeBadgeCommandItems,
  pluginWorktreeBadgeMenuTitle
} from './WorktreePluginBadgeMenuItems'
import {
  useMatchingPluginWorktreeBadges,
  type PluginBadgeRepo,
  type PluginBadgeWorktree,
  type PluginWorktreeBadgeMatch
} from './use-matching-plugin-worktree-badges'

type BadgeProps = {
  worktreeId: string
  onPointerDown: React.PointerEventHandler<HTMLButtonElement>
}

/** One badge's icon button, with a tooltip naming it and a menu of its commands per folder. */
function WorktreeCardPluginBadge({
  match,
  worktreeId,
  onPointerDown
}: BadgeProps & { match: PluginWorktreeBadgeMatch }): React.JSX.Element {
  const { badge } = match
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
        className="w-56"
        onClick={(event) => event.stopPropagation()}
      >
        <DropdownMenuLabel>{pluginWorktreeBadgeMenuTitle(match)}</DropdownMenuLabel>
        <PluginWorktreeBadgeCommandItems match={match} worktreeId={worktreeId} folderFirst />
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** Plugin badges beside the workspace name; each opens a menu of the plugin's workspace commands,
 *  one per project folder the badge found. */
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
  const matches = useMatchingPluginWorktreeBadges(worktree, repo, isActive)
  if (matches.length === 0) {
    return null
  }
  return (
    <>
      {matches.map((match) => (
        <WorktreeCardPluginBadge
          key={match.badge.key}
          match={match}
          worktreeId={worktree.id}
          onPointerDown={onPointerDown}
        />
      ))}
    </>
  )
}
