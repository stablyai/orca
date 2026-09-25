import type { JSX } from 'react'
import { GitFork } from 'lucide-react'
import { DropdownMenuItem } from '@/components/ui/dropdown-menu'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { buildAgentSessionForkModalData } from '@/components/agent-session-fork/agent-session-fork-modal-data'
import { parseWorkspaceKey } from '../../../../shared/workspace-scope'
import type { Repo } from '../../../../shared/repo-types'
import type { Worktree } from '../../../../shared/worktree/types'

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
  const forkable = Boolean(worktree.branch?.trim()) && !worktree.isArchived && !worktree.isBare
  return (
    <DropdownMenuItem
      disabled={isDeleting || !forkable}
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
