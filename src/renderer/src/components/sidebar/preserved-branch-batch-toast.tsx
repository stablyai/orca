import { Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import { mapWithConcurrency } from '../../../../shared/map-with-concurrency'
import { getRepoIdFromWorktreeId } from '../../../../shared/worktree/id'
import { Button } from '../ui/button'
import type { PreservedBranchCleanup } from '@/lib/preserved-branch-cleanup'

const BRANCH_REPO_DELETE_CONCURRENCY = 4

export type ActionablePreservedBranch = PreservedBranchCleanup & { expectedHead: string }

type PreservedBranchDeleteResult = {
  branch: ActionablePreservedBranch
  result: { ok: true; deleted: true } | { ok: false; error: string }
}

function PreservedBranchBatchToastBody({
  branches,
  onReview
}: {
  branches: readonly PreservedBranchCleanup[]
  onReview: () => void
}): React.JSX.Element {
  const actionableCount = branches.filter((branch) => branch.expectedHead).length
  return (
    <div className="flex w-[300px] max-w-[calc(100vw-96px)] flex-col gap-3">
      <p className="min-w-0 break-words text-sm leading-5 text-popover-foreground/80">
        {translate(
          'auto.components.sidebar.preserved.branch.batch.toast.a3cdd9d9e6',
          'Git kept {{count}} local branches because they may contain unmerged commits. Kept branches do not retain workspace folders; their commits remain in the repository. Orca may continue freeing workspace disk space in the background.',
          { count: branches.length }
        )}
      </p>
      {actionableCount > 0 ? (
        <Button type="button" variant="destructive" size="sm" className="w-full" onClick={onReview}>
          <Trash2 className="size-3.5" />
          {translate(
            'auto.components.sidebar.preserved.branch.batch.toast.6310412304',
            'Review {{count}} Branches',
            { count: actionableCount }
          )}
        </Button>
      ) : null}
    </div>
  )
}

export function showPreservedBranchBatchToast(
  workspaceCount: number,
  branches: readonly PreservedBranchCleanup[]
): void {
  if (branches.length === 0) {
    return
  }
  const actionableCount = branches.filter((branch) => branch.expectedHead).length
  const toastId = `preserved-branch-batch:${branches[0].worktreeId}:${branches.length}`
  const removedWorkspaces = translate(
    'auto.components.sidebar.preserved.branch.batch.toast.cea24c2b7d',
    '{{count}} workspaces removed',
    { count: workspaceCount }
  )
  const keptBranches = translate(
    'auto.components.sidebar.preserved.branch.batch.toast.0e0379f24a',
    '{{count}} branches kept',
    { count: branches.length }
  )
  const onReview = (): void => {
    useAppStore.getState().openModal('preserved-branch-review', { branches })
    toast.dismiss(toastId)
  }

  toast.warning(
    translate(
      'auto.components.sidebar.preserved.branch.batch.toast.4cf75caab7',
      '{{value0}}, {{value1}}',
      { value0: removedWorkspaces, value1: keptBranches }
    ),
    {
      id: toastId,
      description: <PreservedBranchBatchToastBody branches={branches} onReview={onReview} />,
      dismissible: true,
      ...(actionableCount > 0 ? { duration: Infinity } : {})
    }
  )
}

export async function forceDeletePreservedBranchBatch(
  branches: readonly ActionablePreservedBranch[]
): Promise<void> {
  if (branches.length === 0) {
    return
  }
  const progressToastId = `force-delete-branch-batch:${branches[0].worktreeId}:${branches.length}`
  toast.loading(
    translate(
      'auto.components.sidebar.preserved.branch.batch.toast.e61d78054f',
      'Deleting local branches: {{value0}}',
      { value0: branches.length }
    ),
    { id: progressToastId }
  )
  const branchesByRepo = new Map<string, ActionablePreservedBranch[]>()
  for (const branch of branches) {
    const repoId = getRepoIdFromWorktreeId(branch.worktreeId)
    const repoBranches = branchesByRepo.get(repoId)
    if (repoBranches) {
      repoBranches.push(branch)
    } else {
      branchesByRepo.set(repoId, [branch])
    }
  }
  const groupResults = await mapWithConcurrency(
    [...branchesByRepo.values()],
    BRANCH_REPO_DELETE_CONCURRENCY,
    async (repoBranches) => {
      const results: PreservedBranchDeleteResult[] = []
      for (const branch of repoBranches) {
        results.push({
          branch,
          result: await useAppStore
            .getState()
            .forceDeletePreservedBranch(branch.worktreeId, branch.branchName, branch.expectedHead, {
              suppressToast: true,
              ...(branch.hostId ? { hostId: branch.hostId } : {}),
              ...(branch.runtimeEnvironmentId
                ? { runtimeEnvironmentId: branch.runtimeEnvironmentId }
                : {})
            })
        })
      }
      return results
    }
  )
  const results = groupResults.flat()
  const failures = results.filter((result) => !result.result.ok)
  if (failures.length === 0) {
    toast.success(
      translate(
        'auto.components.sidebar.preserved.branch.batch.toast.1e1a5f6763',
        'Local branches deleted: {{value0}}',
        { value0: branches.length }
      ),
      { id: progressToastId }
    )
    return
  }
  const deletedCount = branches.length - failures.length
  const description = failures
    .map(({ branch, result }) => (result.ok ? '' : `${branch.branchName}: ${result.error}`))
    .filter(Boolean)
    .join('; ')
  const failedBranches = failures.map(({ branch }) => branch)
  toast.error(
    translate(
      'auto.components.sidebar.preserved.branch.batch.toast.43d9395605',
      '{{value0}} deleted, {{value1}} not deleted',
      { value0: deletedCount, value1: failures.length }
    ),
    {
      id: progressToastId,
      description: (
        <div className="flex w-[300px] max-w-[calc(100vw-96px)] flex-col gap-3">
          <p className="min-w-0 break-words text-sm leading-5 text-popover-foreground/80">
            {description}
          </p>
          <Button
            type="button"
            variant="destructive"
            size="sm"
            className="w-full"
            onClick={() => {
              void forceDeletePreservedBranchBatch(failedBranches)
            }}
          >
            <Trash2 className="size-3.5" />
            {translate(
              'auto.components.sidebar.preserved.branch.batch.toast.d42f1f14e0',
              'Retry {{count}} Branches',
              { count: failedBranches.length }
            )}
          </Button>
        </div>
      ),
      duration: Infinity,
      dismissible: true
    }
  )
}
