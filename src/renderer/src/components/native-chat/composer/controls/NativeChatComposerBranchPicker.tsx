import { useCallback, useMemo } from 'react'
import { GitBranch } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useTranslate } from '@/i18n/use-translate'
import { ipcOrRuntimeTargetForHostId } from '@/runtime/rpc/targets/runtime-client-target'
import { WorkspaceBranchPicker } from '@/components/right-sidebar/source-control/branches/WorkspaceBranchPicker'
import {
  recordWorktreeBranchSwitchLanded,
  refreshWorktreeCopyStatus
} from '@/components/right-sidebar/source-control/branches/workspace-branch-switch-status'
import type { ExecutionHostId } from '../../../../../../shared/execution-host'

export function NativeChatComposerBranchPicker({
  worktreeId,
  worktreePath,
  hostId,
  repoId,
  branch,
  turnActive,
  textClassName,
  onCopyBranch
}: {
  worktreeId: string
  worktreePath: string
  hostId: ExecutionHostId
  repoId: string
  branch: string
  /** This chat's own turn; the picker names it instead of a generic agent. */
  turnActive: boolean
  textClassName: string
  onCopyBranch: () => void
}): React.JSX.Element | null {
  const t = useTranslate()
  const target = useMemo(() => ipcOrRuntimeTargetForHostId(hostId), [hostId])
  const onOpen = useCallback(
    () => refreshWorktreeCopyStatus(worktreeId, hostId, worktreePath),
    [worktreeId, hostId, worktreePath]
  )
  const onLanded = useCallback(
    () => recordWorktreeBranchSwitchLanded(worktreeId, hostId, worktreePath),
    [worktreeId, hostId, worktreePath]
  )
  if (!target) {
    return null
  }
  return (
    <WorkspaceBranchPicker
      worktreeId={worktreeId}
      worktreePath={worktreePath}
      hostId={hostId}
      repoId={repoId}
      target={target}
      branch={branch}
      agentNotice={
        turnActive
          ? t(
              'components.native-chat.composerWorkspace.turnWorking',
              "This chat's agent is working. Switch branches after its turn finishes."
            )
          : undefined
      }
      onOpen={onOpen}
      onCopyBranch={onCopyBranch}
      onLanded={onLanded}
      trigger={
        <Button
          type="button"
          variant="ghost"
          size="xs"
          className="h-5.5 min-w-0 flex-1 justify-start"
          aria-label={t('sourceControl.branchPicker.switch', 'Switch branch: {{branch}}', {
            branch
          })}
        >
          <GitBranch className="size-3" aria-hidden />
          <span className={`${textClassName} font-mono`}>{branch}</span>
        </Button>
      }
    />
  )
}
