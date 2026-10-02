import type { JSX } from 'react'
import { GitFork } from 'lucide-react'
import { DropdownMenuItem } from '@/components/ui/dropdown-menu'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { buildAgentSessionForkModalData } from '@/components/agent-session-fork/agent-session-fork-modal-data'
import { findForkWorktreeRepo } from '@/lib/agent-session-fork-source-repo'
import { parseWorkspaceKey } from '../../../../shared/workspace-scope'
import type { Worktree } from '../../../../shared/worktree/types'

function forkDisabledReason(worktree: Worktree, hasRepo: boolean): string | undefined {
  if (!hasRepo) {
    return translate(
      'components.agentSessionFork.disabledReason.repoMissing',
      "This workspace's project is not available."
    )
  }
  if (worktree.isBare) {
    return translate(
      'components.agentSessionFork.disabledReason.bare',
      'Bare repositories have no working tree to fork.'
    )
  }
  if (worktree.isArchived) {
    return translate(
      'components.agentSessionFork.disabledReason.archived',
      'Unarchive this workspace to fork it.'
    )
  }
  if (!worktree.branch?.trim()) {
    return translate(
      'components.agentSessionFork.disabledReason.detached',
      'Check out a branch first; this workspace is on a detached commit.'
    )
  }
  return undefined
}

export function WorktreeForkAgentSessionMenuItem({
  worktree,
  isDeleting
}: {
  worktree: Worktree
  isDeleting: boolean
}): JSX.Element | null {
  const openModal = useAppStore((s) => s.openModal)
  // Why: the same host-aware lookup the fork flow and terminal gate use.
  const forkRepo = useAppStore((s) => findForkWorktreeRepo(s, worktree))
  if (parseWorkspaceKey(worktree.id)?.type === 'folder' || forkRepo?.kind === 'folder') {
    return null
  }
  const disabledReason = forkDisabledReason(worktree, forkRepo !== null)
  const label = translate('components.agentSessionFork.menuItem', 'Fork Agent Session...')
  return (
    <DropdownMenuItem
      disabled={isDeleting || disabledReason !== undefined}
      onSelect={() =>
        openModal(
          'agent-session-fork',
          buildAgentSessionForkModalData({
            sourceWorktreeId: worktree.id,
            launchSource: 'sidebar',
            preselectedPaneKey: null,
            transcript: null
          })
        )
      }
    >
      <GitFork className="size-3.5" />
      {disabledReason === undefined ? (
        label
      ) : (
        // Why: disabled items are skipped by keyboard and pointer, so the reason must be in the item.
        <span className="grid min-w-0 flex-1 text-left">
          <span>{label}</span>
          <span className="text-[11px] font-normal text-muted-foreground">{disabledReason}</span>
        </span>
      )}
    </DropdownMenuItem>
  )
}
