import type { JSX } from 'react'
import { GitFork } from 'lucide-react'
import { DropdownMenuItem } from '@/components/ui/dropdown-menu'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { buildAgentSessionForkModalData } from '@/components/agent-session-fork/agent-session-fork-modal-data'
import { parseWorkspaceKey } from '../../../../shared/workspace-scope'
import type { Repo } from '../../../../shared/repo-types'
import type { Worktree } from '../../../../shared/worktree/types'

function forkDisabledReason(worktree: Worktree): string | undefined {
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
  repo,
  isDeleting
}: {
  worktree: Worktree
  repo: Repo | null | undefined
  isDeleting: boolean
}): JSX.Element | null {
  const openModal = useAppStore((s) => s.openModal)
  if (parseWorkspaceKey(worktree.id)?.type === 'folder' || repo?.kind === 'folder') {
    return null
  }
  const disabledReason = forkDisabledReason(worktree)
  // Why: Radix forwards `title` to the item, as the Delete item does to explain its disabled state.
  return (
    <DropdownMenuItem
      disabled={isDeleting || disabledReason !== undefined}
      title={disabledReason}
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
      {translate('components.agentSessionFork.menuItem', 'Fork Agent Session...')}
    </DropdownMenuItem>
  )
}
