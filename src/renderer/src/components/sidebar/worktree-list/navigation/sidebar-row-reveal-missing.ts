import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'

/** A requested sidebar row never showed up after every retry. */
export function toastSidebarRowRevealMissing(): void {
  toast.error(
    translate('auto.components.sidebar.WorktreeList.sidebarRowMissing', 'Target no longer exists')
  )
}
