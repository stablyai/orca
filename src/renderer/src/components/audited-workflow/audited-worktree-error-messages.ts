// Maps closed worktree reason codes to user-safe text. Split from
// audited-workflow-error-messages.ts to stay under the max-lines budget.
//
// The switch is exhaustive with no `default`, so lint:switch-exhaustiveness
// fails if a new WorktreeReasonCode is added without a message here.
import { translate } from '@/i18n/i18n'
import type { WorktreeReasonCode } from '../../../../shared/audited-worktree-types'

export function getWorktreeErrorMessage(reasonCode: WorktreeReasonCode): string {
  switch (reasonCode) {
    case 'unsupported_host':
      return translate(
        'auto.components.auditedWorkflow.errors.worktreeUnsupportedHost',
        'Audited Workflow supports local Git repositories only.'
      )
    case 'managed_root_unavailable':
      return translate(
        'auto.components.auditedWorkflow.errors.worktreeManagedRootUnavailable',
        'The workspace folder could not be prepared. Check your workspace directory setting and try again.'
      )
    case 'managed_root_escapes_workspace':
    case 'managed_root_inside_source_repo':
    case 'source_repo_inside_managed_root':
      return translate(
        'auto.components.auditedWorkflow.errors.worktreeManagedRootUnsafe',
        'The configured workspace directory is not a safe location for audited worktrees. Choose a directory outside the repository.'
      )
    case 'branch_already_exists':
      return translate(
        'auto.components.auditedWorkflow.errors.worktreeBranchExists',
        'A branch for this task already exists. Resolve it manually before continuing.'
      )
    case 'worktree_path_occupied':
      return translate(
        'auto.components.auditedWorkflow.errors.worktreePathOccupied',
        'The worktree location is already in use by something else. Resolve it manually before continuing.'
      )
    case 'base_commit_unresolvable':
      return translate(
        'auto.components.auditedWorkflow.errors.worktreeBaseCommitUnresolvable',
        'The base commit for this task is no longer available in the repository.'
      )
    case 'git_worktree_add_failed':
      return translate(
        'auto.components.auditedWorkflow.errors.worktreeAddFailed',
        'Preparing the worktree failed. You can retry.'
      )
    case 'provision_evidence_ambiguous':
      return translate(
        'auto.components.auditedWorkflow.errors.worktreeEvidenceAmbiguous',
        'Worktree preparation left an unclear state. Nothing was changed automatically — please inspect the repository manually.'
      )
    case 'worktree_missing':
      return translate(
        'auto.components.auditedWorkflow.errors.worktreeMissing',
        'The task worktree is missing.'
      )
    case 'worktree_path_outside_managed_root':
    case 'worktree_path_mismatch':
      return translate(
        'auto.components.auditedWorkflow.errors.worktreePathUnexpected',
        'The task worktree is no longer where it is expected to be.'
      )
    case 'repository_identity_mismatch':
      return translate(
        'auto.components.auditedWorkflow.errors.worktreeRepoMismatch',
        'The task worktree belongs to a different repository.'
      )
    case 'head_not_symbolic':
      return translate(
        'auto.components.auditedWorkflow.errors.worktreeHeadDetached',
        'The task worktree has a detached HEAD.'
      )
    case 'head_branch_mismatch':
      return translate(
        'auto.components.auditedWorkflow.errors.worktreeHeadBranchMismatch',
        'The task worktree is on a different branch than expected.'
      )
    case 'head_moved_from_base_commit':
    case 'branch_tip_moved_from_base_commit':
      return translate(
        'auto.components.auditedWorkflow.errors.worktreeMoved',
        'The task worktree has changes that Orca did not make. Review them before continuing.'
      )
    case 'worktree_unreadable':
      return translate(
        'auto.components.auditedWorkflow.errors.worktreeUnreadable',
        'The task worktree could not be read. You can retry.'
      )
    case 'worktree_never_provisioned':
      return translate(
        'auto.components.auditedWorkflow.errors.worktreeNeverProvisioned',
        'This task needs a worktree before it can continue.'
      )
  }
}
