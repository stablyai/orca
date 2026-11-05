import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import type { AppState } from '@/store/types'
import type { ExecutionHostId } from '../../../../../../shared/execution-host'

type SelectParentArgs = {
  childWorktreeId: string | null
  childHostId?: ExecutionHostId
  parentWorktreeId: string
  assignWorktreeParent: AppState['assignWorktreeParent']
  close: () => void
  showError: (message: string) => void
}

export function selectWorktreeParent({
  childWorktreeId,
  childHostId,
  parentWorktreeId,
  assignWorktreeParent,
  close,
  showError
}: SelectParentArgs): void {
  if (!childWorktreeId) {
    return
  }
  close()
  void assignWorktreeParent(childWorktreeId, {
    parentWorktreeId,
    ...(childHostId ? { executionHostId: childHostId } : {})
  }).catch((error) => {
    console.error('Failed to set parent worktree:', error)
    showError(
      translate(
        'auto.components.sidebar.WorktreeParentPickerPopover.failedSetParent',
        'Failed to set parent worktree'
      )
    )
  })
}

/** Cross-machine refusals (an older Orca on the child's machine, an unconfirmed parent) name what to do next. */
export function showCrossStoreParentError(error: unknown): void {
  toast.error(
    translate(
      'auto.components.sidebar.WorktreeParentPickerPopover.failedSetParent',
      'Failed to set parent worktree'
    ),
    { description: error instanceof Error ? error.message : undefined }
  )
}
