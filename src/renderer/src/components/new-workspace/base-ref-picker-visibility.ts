import type { SmartWorkspaceNameSelection } from '@/components/new-workspace/SmartWorkspaceNameField'

/**
 * Whether the composer offers a base ref for the worktree it is about to create.
 *
 * The name field's tabs pick how the workspace is NAMED; the base ref is a separate
 * decision, so the picker stays available for every naming source — except those that
 * already carry a base of their own.
 */
export function shouldShowComposerBaseRefPicker(args: {
  selectedRepoIsGit: boolean
  branchesEnabled: boolean
  smartNameSelectionKind: SmartWorkspaceNameSelection['kind'] | null
}): boolean {
  if (!args.selectedRepoIsGit || !args.branchesEnabled) {
    return false
  }
  // Why: these already carry a base — a PR/MR pins its own head, and a branch pick IS the base,
  // where overriding would silently turn a checkout of it into a new branch off something else.
  return (
    args.smartNameSelectionKind !== 'github-pr' &&
    args.smartNameSelectionKind !== 'gitlab-mr' &&
    args.smartNameSelectionKind !== 'branch'
  )
}
