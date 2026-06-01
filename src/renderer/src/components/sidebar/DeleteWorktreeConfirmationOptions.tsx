import type { JSX } from 'react'
import { Check, GitBranch } from 'lucide-react'

export function DeleteWorktreeConfirmationOptions({
  branchDeleteTargetCount,
  singleBranchDeleteName,
  forceDeletePreservedBranches,
  onToggleForceDeletePreservedBranches,
  showDontAskAgain,
  dontAskAgain,
  onToggleDontAskAgain
}: {
  branchDeleteTargetCount: number
  singleBranchDeleteName: string | undefined
  forceDeletePreservedBranches: boolean
  onToggleForceDeletePreservedBranches: () => void
  showDontAskAgain: boolean
  dontAskAgain: boolean
  onToggleDontAskAgain: () => void
}): JSX.Element {
  return (
    <>
      {branchDeleteTargetCount > 0 && (
        <button
          type="button"
          role="checkbox"
          aria-checked={forceDeletePreservedBranches}
          onClick={onToggleForceDeletePreservedBranches}
          className="flex min-w-0 items-start gap-2 rounded-sm px-1 py-1 text-left text-xs text-foreground/80 transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <span
            className={`mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-sm border transition-colors ${
              forceDeletePreservedBranches
                ? 'border-foreground bg-foreground text-background'
                : 'border-muted-foreground bg-transparent'
            }`}
          >
            {forceDeletePreservedBranches ? <Check className="size-3" strokeWidth={3} /> : null}
          </span>
          <span className="min-w-0 flex-1">
            <span className="flex min-w-0 items-center gap-1.5 font-medium">
              <GitBranch className="size-3.5 shrink-0" />
              <span className="min-w-0 break-words">
                {branchDeleteTargetCount === 1 && singleBranchDeleteName
                  ? `Also delete local branch "${singleBranchDeleteName}" if Git keeps it`
                  : `Also delete kept local branches for ${branchDeleteTargetCount} workspaces`}
              </span>
            </span>
            <span className="mt-0.5 block text-muted-foreground">
              Orca already removes branches Git considers safe. This only force-deletes branches Git
              protects because they may contain unmerged local commits.
            </span>
          </span>
        </button>
      )}

      {showDontAskAgain && (
        <button
          type="button"
          role="checkbox"
          aria-checked={dontAskAgain}
          onClick={onToggleDontAskAgain}
          className="flex items-center gap-2 rounded-sm px-1 py-1 text-xs text-foreground/80 transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <span
            className={`flex size-4 items-center justify-center rounded-sm border transition-colors ${
              dontAskAgain
                ? 'border-foreground bg-foreground text-background'
                : 'border-muted-foreground bg-transparent'
            }`}
          >
            {dontAskAgain ? <Check className="size-3" strokeWidth={3} /> : null}
          </span>
          Don&apos;t ask again
        </button>
      )}
    </>
  )
}
