import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import type { UpdateCheckOptions } from '../../../../../shared/updater/update-status-types'

/** Starts an updater check from About; a rejected request is reported instead of being dropped. */
export function runUpdateCheck(options?: UpdateCheckOptions): void {
  void window.api.updater.check(options).catch((error: unknown) => {
    toast.error(
      translate('auto.components.UpdateCard.checkFailed', 'Could not check for updates.'),
      {
        description: error instanceof Error ? error.message : String(error)
      }
    )
  })
}
