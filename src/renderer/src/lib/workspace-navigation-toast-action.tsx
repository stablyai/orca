import { ExternalLink } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { activateAndRevealWorkspace } from '@/lib/worktree-activation'
import type { ExecutionHostId } from '../../../shared/execution-host'

export function workspaceNavigationToastAction({
  workspaceId,
  executionHostId,
  isFolder = true,
  onNavigate
}: {
  workspaceId: string
  executionHostId?: ExecutionHostId
  isFolder?: boolean
  onNavigate?: () => void
}) {
  const label = isFolder
    ? translate('components.workspace.creation.goToWorkspace', 'Go to workspace')
    : translate('components.workspace.creation.goToWorktree', 'Go to worktree')
  return {
    label: (
      <span className="inline-flex items-center gap-1.5">
        <ExternalLink className="size-3" />
        {label}
      </span>
    ),
    onClick: () => {
      onNavigate?.()
      activateAndRevealWorkspace(workspaceId, {
        sidebarRevealBehavior: 'auto',
        navigationIntent: 'user-open',
        ...(executionHostId ? { executionHostId } : {})
      })
    }
  }
}
