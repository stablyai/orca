import type React from 'react'
import { toast } from 'sonner'
import { DropdownMenuItem } from '@/components/ui/dropdown-menu'
import { translate } from '@/i18n/i18n'
import { extractIpcErrorMessage } from '@/runtime/errors/ipc-error'
import { executePluginCommand } from '@/lib/plugins/commands/plugin-command-execution'
import { showPluginCommandMessage } from '@/lib/plugins/commands/plugin-command-message'
import type { ActivePluginCommand } from '@/store/plugins/catalog/plugin-contribution-catalog'
import { PluginWorktreeBadgeIcon } from './PluginWorktreeBadgeIcon'
import {
  useMatchingPluginWorktreeBadges,
  type PluginBadgeRepo,
  type PluginBadgeWorktree,
  type PluginWorktreeBadgeMatch
} from './use-matching-plugin-worktree-badges'

/** Runs `command` on the workspace (and `folder`, unless it is the workspace's own `''`), showing
 *  its message, or a toast when it fails. */
async function runPluginWorktreeCommand(
  command: ActivePluginCommand,
  worktreeId: string,
  folder: string
): Promise<void> {
  try {
    showPluginCommandMessage(
      await executePluginCommand(command, 'plugin-palette', {
        worktreeId,
        ...(folder ? { folder } : {})
      })
    )
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

/** The badge menu's heading: its one command when the items below name the matched folders. */
export function pluginWorktreeBadgeMenuTitle({ badge, folders }: PluginWorktreeBadgeMatch): string {
  const [onlyCommand, ...others] = badge.commands
  return onlyCommand && others.length === 0 && folders[0] !== '' ? onlyCommand.title : badge.title
}

/** One item per matched folder and command. `folderFirst` names the folder, under a heading that
 *  names the command; otherwise the folder follows the command, as in the workspace context menu. */
export function PluginWorktreeBadgeCommandItems({
  match,
  worktreeId,
  disabled,
  folderFirst
}: {
  match: PluginWorktreeBadgeMatch
  worktreeId: string
  disabled?: boolean
  folderFirst?: boolean
}): React.JSX.Element {
  const { badge, folders } = match
  return (
    <>
      {folders.flatMap((folder) =>
        badge.commands.map((command) => (
          <DropdownMenuItem
            key={`${command.id}/${folder}`}
            disabled={disabled}
            onSelect={() => void runPluginWorktreeCommand(command, worktreeId, folder)}
          >
            <PluginWorktreeBadgeIcon icon={badge.icon} className="size-3.5" />
            <span className="truncate">{folderFirst && folder ? folder : command.title}</span>
            {folder && (!folderFirst || badge.commands.length > 1) ? (
              <span className="ml-auto truncate pl-2 text-xs text-muted-foreground">
                {folderFirst ? command.title : folder}
              </span>
            ) : null}
          </DropdownMenuItem>
        ))
      )}
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
  const matches = useMatchingPluginWorktreeBadges(worktree, repo)
  if (matches.length === 0) {
    return null
  }
  return (
    <>
      {matches.map((match) => (
        <PluginWorktreeBadgeCommandItems
          key={match.badge.key}
          match={match}
          worktreeId={worktree.id}
          disabled={disabled}
        />
      ))}
    </>
  )
}
