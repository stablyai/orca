import type React from 'react'
import { toast } from 'sonner'
import { DropdownMenuItem } from '@/components/ui/dropdown-menu'
import { translate } from '@/i18n/i18n'
import { extractIpcErrorMessage } from '@/lib/ipc-error'
import { executePluginCommand } from '@/lib/plugin-command-execution'
import { showPluginCommandMessage } from '@/lib/plugin-command-message'
import type { ActivePluginCommand } from '@/store/plugins/catalog/plugin-contribution-catalog'
import type { ActivePluginWorktreeBadge } from '@/store/plugins/worktree-badges/plugin-worktree-badges'
import { PluginWorktreeBadgeIcon } from './PluginWorktreeBadgeIcon'
import {
  useMatchingPluginWorktreeBadges,
  type PluginBadgeRepo,
  type PluginBadgeWorktree
} from './use-matching-plugin-worktree-badges'

async function runPluginWorktreeCommand(
  command: ActivePluginCommand,
  worktreeId: string
): Promise<void> {
  try {
    showPluginCommandMessage(await executePluginCommand(command, 'plugin-palette', { worktreeId }))
  } catch (error) {
    // Why the first line: a worker reports a failed command as its stack.
    const detail = extractIpcErrorMessage(error, '').split('\n')[0]?.trim()
    toast.error(
      translate(
        'auto.components.sidebar.WorktreePluginBadgeMenuItems.failed',
        'Could not run {{value0}}',
        { value0: command.title }
      ),
      detail ? { description: detail } : undefined
    )
  }
}

/** One badge's commands, for the badge's own menu and the workspace context menu. */
export function PluginWorktreeBadgeCommandItems({
  badge,
  worktreeId,
  disabled
}: {
  badge: ActivePluginWorktreeBadge
  worktreeId: string
  disabled?: boolean
}): React.JSX.Element {
  return (
    <>
      {badge.commands.map((command) => (
        <DropdownMenuItem
          key={command.id}
          disabled={disabled}
          onSelect={() => void runPluginWorktreeCommand(command, worktreeId)}
        >
          <PluginWorktreeBadgeIcon icon={badge.icon} className="size-3.5" />
          {command.title}
        </DropdownMenuItem>
      ))}
    </>
  )
}

/** Workspace context menu entries for every plugin badge that matches the workspace. */
export function WorktreePluginBadgeMenuItems({
  worktree,
  repo,
  disabled
}: {
  worktree: PluginBadgeWorktree
  repo: PluginBadgeRepo
  disabled?: boolean
}): React.JSX.Element | null {
  const badges = useMatchingPluginWorktreeBadges(worktree, repo)
  if (badges.length === 0) {
    return null
  }
  return (
    <>
      {badges.map((badge) => (
        <PluginWorktreeBadgeCommandItems
          key={badge.key}
          badge={badge}
          worktreeId={worktree.id}
          disabled={disabled}
        />
      ))}
    </>
  )
}
