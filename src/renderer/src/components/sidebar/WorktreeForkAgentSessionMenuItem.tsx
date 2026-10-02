import type { JSX } from 'react'
import { GitFork } from 'lucide-react'
import { DropdownMenuItem } from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { buildAgentSessionForkModalData } from '@/components/agent-session-fork/agent-session-fork-modal-data'
import { findForkWorktreeRepo } from '@/lib/agent-session-fork-source-repo'
import { parseWorkspaceKey } from '../../../../shared/workspace-scope'
import type { Repo } from '../../../../shared/repo-types'
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
  repo,
  isDeleting
}: {
  worktree: Worktree
  repo: Repo | null | undefined
  isDeleting: boolean
}): JSX.Element | null {
  const openModal = useAppStore((s) => s.openModal)
  // Why: the same host-aware lookup the fork flow and terminal gate use.
  const hasForkRepo = useAppStore((s) => findForkWorktreeRepo(s, worktree) !== null)
  if (parseWorkspaceKey(worktree.id)?.type === 'folder' || repo?.kind === 'folder') {
    return null
  }
  const disabledReason = forkDisabledReason(worktree, hasForkRepo)
  const item = (
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
      {translate('components.agentSessionFork.menuItem', 'Fork Agent Session...')}
    </DropdownMenuItem>
  )
  if (disabledReason === undefined) {
    return item
  }
  // Why: a disabled item ignores the pointer, so the wrapper is what opens the tooltip.
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div>{item}</div>
      </TooltipTrigger>
      <TooltipContent side="right" sideOffset={8} className="max-w-[200px] text-pretty">
        {disabledReason}
      </TooltipContent>
    </Tooltip>
  )
}
