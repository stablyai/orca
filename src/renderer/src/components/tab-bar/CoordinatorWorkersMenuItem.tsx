import { Users } from 'lucide-react'
import { ContextMenuItem } from '@/components/ui/context-menu'
import { useAppStore } from '@/store/index'
import { useTranslate } from '@/i18n/use-translate'
import { selectCoordinatorHasWorkers } from './worker-tab-presentation'
import { openCoordinatorWorkers } from './CoordinatorWorkersBadge'

/** The keyboard path to a coordinator's worker list; shown once it has a stamped worker. */
export function CoordinatorWorkersMenuItem({
  coordinatorTabId
}: {
  coordinatorTabId: string
}): React.JSX.Element | null {
  const t = useTranslate()
  const hasWorkers = useAppStore((state) => selectCoordinatorHasWorkers(state, coordinatorTabId))
  if (!hasWorkers) {
    return null
  }
  return (
    <ContextMenuItem onSelect={() => openCoordinatorWorkers(coordinatorTabId)}>
      <Users className="size-3.5 shrink-0" />
      {t('workerTabs.menu.workers', 'Workers…')}
    </ContextMenuItem>
  )
}
