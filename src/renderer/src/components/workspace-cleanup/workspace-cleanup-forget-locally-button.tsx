import { Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import type { WorkspaceCleanupCandidate } from '../../../../shared/workspace-cleanup'
import { resolveWorkspaceCleanupRemovalHostId } from '../../../../shared/workspace-cleanup-host-identity'
import { runWorktreeDelete } from '@/components/sidebar/delete-worktree-flow'

export function openWorkspaceCleanupForgetLocally(candidate: WorkspaceCleanupCandidate): void {
  runWorktreeDelete(candidate.worktreeId, {
    expectedHostId: resolveWorkspaceCleanupRemovalHostId(candidate) ?? undefined
  })
}

export function WorkspaceCleanupForgetLocallyButton({
  candidate,
  onForget
}: {
  candidate: WorkspaceCleanupCandidate
  onForget: (candidate: WorkspaceCleanupCandidate) => void
}): React.JSX.Element {
  const label = translate(
    'auto.components.sidebar.ForgetSshWorkspaceDialog.forget',
    'Remove from Orca'
  )
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={label}
          onClick={() => onForget(candidate)}
        >
          <Trash2 className="size-3.5" />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={4}>
        {label}
      </TooltipContent>
    </Tooltip>
  )
}
