import { Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import type { RemoveWorktreeResult, Worktree } from '../../../../shared/types'
import { translate } from '@/i18n/i18n'
import { Button } from '../ui/button'

type PreservedBranchWorktree = Pick<Worktree, 'displayName' | 'isMainWorktree'>

type PreservedBranchToastBodyProps = {
  description: string
  forceDeleteLabel: string | undefined
  onForceDelete: (() => void) | undefined
}

function preservedBranchToastId(branchName: string, expectedHead: string | undefined): string {
  return `preserved-branch:${branchName}:${expectedHead ?? 'unknown'}`
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
            variant="default"
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

  const targetTitle = worktree?.isMainWorktree ? 'Workspace' : 'Worktree'
  const targetLabel = targetTitle.toLowerCase()
  const targetName = worktree?.displayName?.trim()
  const deletedTarget = targetName ? ` after deleting ${targetLabel} "${targetName}"` : ''
  const expectedHead = preservedBranch.head
  const toastId = preservedBranchToastId(branch, expectedHead)
  const forceDeleteLabel = expectedHead
    ? translate('auto.store.slices.worktrees.e50495aae6', 'Force Delete Branch')
    : undefined
  const description = translate(
    'auto.store.slices.worktrees.d1d78a7baa',
    'Git could not safely delete branch "{{value0}}"{{value1}}, so Orca kept it to avoid losing local commits.',
    { value0: branch, value1: deletedTarget }
  )
  const forceDelete = expectedHead
    ? (): void => {
        onForceDelete(branch, expectedHead)
        toast.dismiss(toastId)
      }
    : undefined

  toast.warning(
    translate('auto.store.slices.worktrees.4e6496f3d2', '{{value0}} deleted, branch kept', {
      value0: targetTitle
    }),
    {
      id: toastId,
      description: (
        <PreservedBranchToastBody
          description={description}
          forceDeleteLabel={forceDeleteLabel}
          onForceDelete={forceDelete}
        />
      ),
      dismissible: true,
      ...(expectedHead ? { duration: Infinity } : {})
    }
  )
}
