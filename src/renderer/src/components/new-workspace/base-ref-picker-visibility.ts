import type { SmartWorkspaceNameSelection } from '@/components/new-workspace/smart-workspace-name-field-model'
import type { SmartNameMode } from '../../../../shared/new-workspace/smart-workspace-source-results'

/** Naming source and base ref are independent, except PR/MR/branch selections already carry their own base. */
export function shouldShowComposerBaseRefPicker(args: {
  selectedRepoIsGit: boolean
  branchesEnabled: boolean
  smartNameMode: SmartNameMode
  smartNameSelectionKind: SmartWorkspaceNameSelection['kind'] | null
}): boolean {
  if (!args.selectedRepoIsGit || !args.branchesEnabled) {
    return false
  }
  if (args.smartNameMode === 'branches') {
    return false
  }
  // PR/MR heads and branch picks define the checkout; overriding would silently create a different branch.
  return (
    args.smartNameSelectionKind !== 'github-pr' &&
    args.smartNameSelectionKind !== 'gitlab-mr' &&
    args.smartNameSelectionKind !== 'branch'
  )
}
