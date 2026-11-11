import { useCallback } from 'react'
import { GitBranch } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useTranslate } from '@/i18n/use-translate'
import { useWorktreeGitOwnerTarget } from '@/components/right-sidebar/source-control/sync/worktree-git-owner-target'
import { WorkspaceBranchPicker } from '@/components/right-sidebar/source-control/branches/WorkspaceBranchPicker'
import { recordWorktreeBranchSwitchLanded } from '@/components/right-sidebar/source-control/branches/workspace-branch-switch-status'
import type { ExecutionHostId } from '../../../../../../shared/execution-host'

// Hover fill is the button box, so growing into the empty row paints blank space.
export const NATIVE_CHAT_COMPOSER_BRANCH_BUTTON_CLASS =
  'h-5.5 min-w-0 w-fit max-w-full shrink justify-start'

export function NativeChatComposerBranchPicker({
  worktreeId,
  worktreePath,
  hostId,
  repoId,
  branch,
  turnActive,
  textClassName,
  onCopyBranch,
  fallback
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
  /** Shown while the copy's owner is unresolved, so no git call can reach another host's copy. */
  fallback: React.ReactNode
}): React.JSX.Element | null {
  const t = useTranslate()
  // The same owner resolution as the status read, so both reach one copy.
  const target = useWorktreeGitOwnerTarget(worktreeId, hostId)
  const onLanded = useCallback(
    () => recordWorktreeBranchSwitchLanded(worktreeId, hostId, worktreePath),
    [worktreeId, hostId, worktreePath]
  )
  if (!target) {
    return <>{fallback}</>
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
      refreshOnOpen
      onCopyBranch={onCopyBranch}
      onLanded={onLanded}
      trigger={
        <Button
          type="button"
          variant="ghost"
          size="xs"
          className={NATIVE_CHAT_COMPOSER_BRANCH_BUTTON_CLASS}
          title={branch}
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
