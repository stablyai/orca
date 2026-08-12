import { Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import type { RemoveWorktreeResult, Worktree } from '../../../../shared/types'
import { translate } from '@/i18n/i18n'
import { Button } from '../ui/button'
import { createBrowserUuid } from '@/lib/browser-uuid'

type PreservedBranchWorktree = Pick<Worktree, 'displayName' | 'isMainWorktree'>

type PreservedBranchToastBodyProps = {
  description: string
  forceDeleteLabel: string | undefined
  onForceDelete: (() => void) | undefined
}

function getPreservedBranchTitle(isWorkspace: boolean): string {
  return isWorkspace
    ? translate('auto.store.slices.worktrees.5366d13eec', 'Workspace deleted, branch kept')
    : translate('auto.store.slices.worktrees.2e17f825d4', 'Worktree deleted, branch kept')
}

function getPreservedBranchDescription(
  branch: string,
  targetName: string | undefined,
  isWorkspace: boolean
): string {
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
  onForceDelete: (branchName: string, expectedHead: string) => Promise<boolean>,
  onRelease: () => void = () => {},
  cleanupId = createBrowserUuid()
): void {
  const preservedBranch = result?.preservedBranch
  const branch = preservedBranch?.branchName
  if (!branch) {
    return
  }

  const isWorkspace = worktree?.isMainWorktree === true
  const targetName = worktree?.displayName?.trim()
  const expectedHead = preservedBranch.head
  const toastId = `preserved-branch:${cleanupId}`
  const forceDeleteLabel = expectedHead
    ? translate('auto.store.slices.worktrees.e50495aae6', 'Force Delete Branch')
    : undefined
  const description = getPreservedBranchDescription(branch, targetName, isWorkspace)
  let reviewCompleted = false
  let forceDeleteStarted = false
  const forceDelete = expectedHead
    ? (): void => {
        if (forceDeleteStarted) {
          return
        }
        forceDeleteStarted = true
        void onForceDelete(branch, expectedHead).then(
          (deleted) => {
            forceDeleteStarted = false
            if (deleted) {
              reviewCompleted = true
              toast.dismiss(toastId)
            }
          },
          () => {
            forceDeleteStarted = false
          }
        )
      }
    : undefined
  const release = (): void => {
    if (!reviewCompleted) {
      reviewCompleted = true
      onRelease()
    }
  }

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
    onDismiss: release,
    onAutoClose: release,
    ...(expectedHead ? { duration: Infinity } : {})
  })
}
