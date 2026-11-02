import { toast } from 'sonner'
import { localizeWslDistroHoldText } from '@/lib/wsl-distro-hold-copy'

/** The host's create warning; a held terminal reads in the user's language, naming its distro. */
export function showWorktreeCreateWarningToast(warning: string | undefined): void {
  if (warning) {
    toast.warning(localizeWslDistroHoldText(warning))
  }
}
