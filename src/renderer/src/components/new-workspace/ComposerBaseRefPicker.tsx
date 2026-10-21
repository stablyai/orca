import React from 'react'
import { CreateFromPicker } from '@/components/repo/CreateFromPicker'
import { useAppStore } from '@/store'
import { useRepoMap, useWorktreesForRepo } from '@/store/selectors'
import { getRepoExecutionHostId } from '../../../../shared/execution-host'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'

type ComposerBaseRefPickerProps = {
  repoId: string
  baseBranch: string | undefined
  onBaseBranchChange: (value: string | undefined) => void
  resetHint: string | null | undefined
  readOnly?: boolean
}

/**
 * Base ref control for the New Workspace composer.
 *
 * Owns its own store reads so the name section stays presentational and the
 * worktree subscription only exists while the picker is actually on screen.
 */
export function ComposerBaseRefPicker({
  repoId,
  baseBranch,
  onBaseBranchChange,
  resetHint,
  readOnly = false
}: ComposerBaseRefPickerProps): React.JSX.Element {
  const repoMap = useRepoMap()
  const repo = repoMap.get(repoId)
  const repoWorktrees = useWorktreesForRepo(repoId)
  const updateRepo = useAppStore((state) => state.updateRepo)
  return (
    <div className="space-y-1">
      <CreateFromPicker
        // Why: branch search state is repo-scoped, so a project switch must drop it before the next paint.
        key={repoId}
        repoId={repoId}
        repoMap={repoMap}
        worktrees={repoWorktrees}
        value={baseBranch ?? ''}
        compact
        readOnly={readOnly}
        onValueChange={(nextBaseBranch) => onBaseBranchChange(nextBaseBranch || undefined)}
        onSetDefault={
          readOnly
            ? undefined
            : async (nextBaseBranch) => {
                const updated = await updateRepo(
                  repoId,
                  { worktreeBaseRef: nextBaseBranch },
                  repo ? { hostId: getRepoExecutionHostId(repo) } : undefined
                )
                if (!updated) {
                  toast.error(
                    translate(
                      'auto.components.NewWorkspaceComposerCard.defaultBranchUpdateFailed',
                      'Could not update the project default branch. Try again.'
                    )
                  )
                }
              }
        }
      />
      {resetHint ? <p className="text-[11px] text-muted-foreground">{resetHint}</p> : null}
    </div>
  )
}

export default ComposerBaseRefPicker
