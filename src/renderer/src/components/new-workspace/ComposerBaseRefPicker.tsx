import React from 'react'
import { CreateFromPicker } from '@/components/repo/CreateFromPicker'
import { useRepoMap, useWorktreesForRepo } from '@/store/selectors'

type ComposerBaseRefPickerProps = {
  repoId: string
  baseBranch: string | undefined
  onBaseBranchChange: (value: string | undefined) => void
  resetHint: string | null | undefined
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
  resetHint
}: ComposerBaseRefPickerProps): React.JSX.Element {
  const repoMap = useRepoMap()
  const repoWorktrees = useWorktreesForRepo(repoId)
  return (
    <div className="space-y-1 pt-1">
      <CreateFromPicker
        // Why: branch search state is repo-scoped, so a project switch must drop it before the next paint.
        key={repoId}
        repoId={repoId}
        repoMap={repoMap}
        worktrees={repoWorktrees}
        value={baseBranch ?? ''}
        onValueChange={(nextBaseBranch) => onBaseBranchChange(nextBaseBranch || undefined)}
      />
      {resetHint ? <p className="text-[11px] text-muted-foreground">{resetHint}</p> : null}
    </div>
  )
}

export default ComposerBaseRefPicker
