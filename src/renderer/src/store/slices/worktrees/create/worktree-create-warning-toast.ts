import { toast } from 'sonner'
import { localizeWslDistroHoldText } from '@/runtime/hosts/wsl/wsl-distro-hold-copy'
import type { CreateWorktreeResult } from '../../../../../../shared/worktree/create-types'
import { showLocalBaseRefDriftWarningToast } from './local-base-ref-drift-warning-toast'

/** The host's create warning; a held terminal reads in the user's language, naming its distro. */
export function showWorktreeCreateWarningToast(
  result: Pick<CreateWorktreeResult, 'warning' | 'localBaseRefDriftWarning' | 'worktree'>
): void {
  const warning = result.warning ? localizeWslDistroHoldText(result.warning) : undefined
  if (result.localBaseRefDriftWarning) {
    showLocalBaseRefDriftWarningToast(result.localBaseRefDriftWarning, result.worktree, warning)
  } else if (warning) {
    toast.warning(warning)
  }
}
