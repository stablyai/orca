import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'

// Why module-level: one cap explanation per app session, shared by every worktree whose
// reconciler run finds more than nine agent tabs.
let tiledAgentsCapToastShown = false

/** Shows the tiled-agents pane-cap explanation once per app session, regardless of caller. */
export function notifyTiledAgentsPaneCapReached(): void {
  if (tiledAgentsCapToastShown) {
    return
  }
  tiledAgentsCapToastShown = true
  toast.info(
    translate(
      'auto.components.tab.group.TiledAgentsCapNotification.capToast.title',
      'Showing the first 9 agents as cards'
    ),
    {
      description: translate(
        'auto.components.tab.group.TiledAgentsCapNotification.capToast.description',
        'Additional agents open as ordinary tabs.'
      )
    }
  )
}
