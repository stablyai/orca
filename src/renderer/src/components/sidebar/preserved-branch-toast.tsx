import { Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import type {
  PreservedWorktreeBranch,
  RemoveWorktreeResult,
  Worktree
} from '../../../../shared/types'
import { translate } from '@/i18n/i18n'
import { Button } from '../ui/button'

type PreservedBranchWorktree = Pick<Worktree, 'displayName' | 'isMainWorktree'>
type PreservedBranchReason = PreservedWorktreeBranch['reason']

type PreservedBranchToastBodyProps = {
  description: string
  forceDeleteLabel: string | undefined
  onForceDelete: (() => void) | undefined
}

function preservedBranchToastId(branchName: string, expectedHead: string | undefined): string {
  return `preserved-branch:${branchName}:${expectedHead ?? 'unknown'}`
}

function getPreservedBranchTitle(isWorkspace: boolean): string {
  return isWorkspace
    ? translate('auto.store.slices.worktrees.5366d13eec', 'Workspace deleted, branch kept')
    : translate('auto.store.slices.worktrees.2e17f825d4', 'Worktree deleted, branch kept')
}

function getPreservedBranchDescription(
  branch: string,
  targetName: string | undefined,
  isWorkspace: boolean,
  reason: PreservedBranchReason
): string {
  // Why separate copy: Git refusing an unmerged delete and Orca declining to touch a branch
  // are different events, and the unmerged wording would misinform in the other two cases.
  if (reason === 'default-branch') {
    return translate(
      'auto.components.sidebar.preserved.branch.toast.defaultBranchKept',
      'Branch "{{value0}}" is this repository\'s default branch, so Orca kept it.',
      { value0: branch }
    )
  }
  if (reason === 'checkout-drift') {
    return targetName
      ? translate(
          'auto.components.sidebar.preserved.branch.toast.driftedBranchKeptNamed',
          'Workspace "{{value1}}" had branch "{{value0}}" checked out, which is not the branch Orca created for it, so Orca kept the branch.',
          { value0: branch, value1: targetName }
        )
      : translate(
          'auto.components.sidebar.preserved.branch.toast.driftedBranchKept',
          'Branch "{{value0}}" is not the branch Orca created for this workspace, so Orca kept it.',
          { value0: branch }
        )
  }
  if (!targetName) {
    return translate(
      'auto.store.slices.worktrees.78e08cd877',
      'Git could not safely delete branch "{{value0}}", so Orca kept it to avoid losing local commits.',
      { value0: branch }
    )
  }
  return isWorkspace
    ? translate(
        'auto.store.slices.worktrees.3b57982bf6',
        'Git could not safely delete branch "{{value0}}" after deleting workspace "{{value1}}", so Orca kept it to avoid losing local commits.',
        { value0: branch, value1: targetName }
      )
    : translate(
        'auto.store.slices.worktrees.81f13f48d2',
        'Git could not safely delete branch "{{value0}}" after deleting worktree "{{value1}}", so Orca kept it to avoid losing local commits.',
        { value0: branch, value1: targetName }
      )
}

// Why: Sonner's native action row pinches long branch/worktree names into a
// narrow column. Keep the native toast frame, but give the body its own footer.
function PreservedBranchToastBody({
  description,
  forceDeleteLabel,
  onForceDelete
}: PreservedBranchToastBodyProps): React.JSX.Element {
  return (
    <div className="flex w-[300px] max-w-[calc(100vw-96px)] flex-col gap-3">
      <p className="min-w-0 break-words text-sm leading-5 text-popover-foreground/80">
        {description}
      </p>
      {forceDeleteLabel && onForceDelete ? (
        <div className="flex min-w-0 overflow-hidden">
          <Button
            type="button"
            variant="destructive"
            size="sm"
            className="w-full min-w-0"
            onClick={onForceDelete}
          >
            <Trash2 className="size-3.5" />
            <span className="truncate">{forceDeleteLabel}</span>
          </Button>
        </div>
      ) : null}
    </div>
  )
}

export function showPreservedBranchToast(
  result: RemoveWorktreeResult | undefined,
  worktree: PreservedBranchWorktree | undefined,
  onForceDelete: (branchName: string, expectedHead: string) => void
): void {
  const preservedBranch = result?.preservedBranch
  const branch = preservedBranch?.branchName
  if (!branch) {
    return
  }

  const isWorkspace = worktree?.isMainWorktree === true
  const targetName = worktree?.displayName?.trim()
  const expectedHead = preservedBranch.head
  const toastId = preservedBranchToastId(branch, expectedHead)
  // Why no force button for the default branch: one click away from the exact trunk deletion
  // this guard exists to prevent. Deleting it stays a deliberate act outside Orca.
  const offerForceDelete = !!expectedHead && preservedBranch.reason !== 'default-branch'
  const forceDeleteLabel = offerForceDelete
    ? translate('auto.store.slices.worktrees.e50495aae6', 'Force Delete Branch')
    : undefined
  const description = getPreservedBranchDescription(
    branch,
    targetName,
    isWorkspace,
    preservedBranch.reason
  )
  const forceDelete =
    offerForceDelete && expectedHead
      ? (): void => {
          onForceDelete(branch, expectedHead)
          toast.dismiss(toastId)
        }
      : undefined

  toast.warning(getPreservedBranchTitle(isWorkspace), {
    id: toastId,
    description: (
      <PreservedBranchToastBody
        description={description}
        forceDeleteLabel={forceDeleteLabel}
        onForceDelete={forceDelete}
      />
    ),
    dismissible: true,
    // Why: only a toast carrying an action may not auto-dismiss before it is used.
    ...(offerForceDelete ? { duration: Infinity } : {})
  })
}
