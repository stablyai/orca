import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import type { RemoveWorktreeResult } from '../../../../shared/worktree/create-types'

export function showNestedWorktreePreservedBranchesToast(
  branches: RemoveWorktreeResult['nestedPreservedBranches']
): void {
  if (!branches?.length) {
    return
  }
  toast.info(
    translate(
      'worktree.nestedRemoval.preservedBranches',
      'Some nested worktree branches were kept'
    ),
    { description: branches.map((item) => item.branchName).join(', ') }
  )
}
