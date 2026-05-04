/**
 * Setup step for AddRepoDialog — shown after a repo is added, cloned, or created.
 * Split out so the parent dialog stays under the 400-line oxlint limit.
 */

import React from 'react'
import { GitBranchPlus, Settings } from 'lucide-react'
import { DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { LinkedWorktreeItem } from './LinkedWorktreeItem'
import type { Worktree } from '../../../../shared/types'

type SetupStepProps = {
  repoName: string
  sortedWorktrees: Worktree[]
  onOpenWorktree: (worktree: Worktree) => void
  onCreateWorktree: () => void
  onConfigureRepo: () => void
  onSkip: () => void
}

export function SetupStep({
  repoName,
  sortedWorktrees,
  onOpenWorktree,
  onCreateWorktree,
  onConfigureRepo,
  onSkip
}: SetupStepProps): React.JSX.Element {
  const hasWorktrees = sortedWorktrees.length > 0
  const worktreeCount = sortedWorktrees.length

  return (
    <>
      <DialogHeader>
        <DialogTitle>
          {hasWorktrees ? 'Open or create a worktree' : 'Set up your first worktree'}
        </DialogTitle>
        <DialogDescription>
          {hasWorktrees
            ? `${repoName} has ${worktreeCount} worktree${worktreeCount !== 1 ? 's' : ''}. Open one to pick up where you left off, or create a new one.`
            : `Orca uses git worktrees as isolated task environments. Create one for ${repoName} to get started.`}
        </DialogDescription>
      </DialogHeader>

      {hasWorktrees && (
        <div className="space-y-2 min-w-0">
          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
            Existing worktrees
          </p>
          <div className="space-y-1.5 max-h-[40vh] overflow-y-auto scrollbar-sleek pr-1">
            {sortedWorktrees.map((wt) => (
              <LinkedWorktreeItem key={wt.id} worktree={wt} onOpen={() => onOpenWorktree(wt)} />
            ))}
          </div>
        </div>
      )}

      <div className="flex flex-col gap-3 pt-2">
        <Button onClick={onCreateWorktree} className="w-full">
          <GitBranchPlus className="size-4 mr-2" />
          {hasWorktrees ? 'Create new worktree' : 'Create first worktree'}
        </Button>

        <div className="flex items-center justify-between">
          <button
            className="inline-flex items-center justify-center gap-1.5 text-xs text-muted-foreground/70 hover:text-foreground transition-colors cursor-pointer"
            onClick={onConfigureRepo}
          >
            <Settings className="size-3" />
            Configure project
          </button>
          <Button variant="ghost" size="sm" className="text-xs" onClick={onSkip}>
            Skip
          </Button>
        </div>
      </div>
    </>
  )
}
