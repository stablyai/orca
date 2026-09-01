import { translate } from '@/i18n/i18n'
import { stripIpcInvokeEnvelope } from '@/lib/ipc-error'

/**
 * User-facing text for a workspace-removal failure Orca could not classify.
 *
 * Every unclassified failure reaches a user through this one function, so Electron's IPC
 * envelope cannot leak into the delete toast, the delete dialog, or the space manager.
 * Nothing is discarded: `deleteStateByWorktreeId` keeps the raw string, the renderer logs
 * the rejection, and Electron logs the handler's original error with its stack in main.
 */
export function getWorktreeRemovalErrorCopy(error: string): string {
  return (
    stripIpcInvokeEnvelope(error) ??
    translate(
      'auto.components.sidebar.worktree.removal.error.copy.unreadable',
      'Orca could not delete this workspace, and the failure did not include a readable reason. Retry, and send app diagnostics to support if it keeps failing.'
    )
  )
}

/**
 * Same contract for the branch a deleted workspace left behind: the preserved-branch toast
 * runs its own IPC call, so it can surface the same envelope from a different channel.
 */
export function getPreservedBranchDeletionErrorCopy(error: string): string {
  return (
    stripIpcInvokeEnvelope(error) ??
    translate(
      'auto.components.sidebar.worktree.removal.error.copy.branchUnreadable',
      'Orca could not delete this branch, and the failure did not include a readable reason. Retry, and send app diagnostics to support if it keeps failing.'
    )
  )
}
