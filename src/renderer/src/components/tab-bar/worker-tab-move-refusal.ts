import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'

export function showWorkerTabMoveRefusal(code: string): void {
  if (code === 'worker_tab_conflict') {
    toast.error(
      translate(
        'workerTabs.move.refused',
        "Can't move this pane · that tab belongs to another worker"
      )
    )
  }
}
