import { sendLayoutCommandToOwner } from '@/runtime/layout-owner-command'
import type { PaneManager } from '@/lib/pane-manager/pane-manager'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../shared/layout-owner-switch'
import { layoutFramesFlowing } from '@/runtime/layout-frame-position'

/** Equalizes a tab's panes, then `then` runs (focus); in a layout-owner build main equalizes. */
export function equalizeTerminalPanes(
  pane: { worktreeId: string; tabId: string; getManager: () => PaneManager | null },
  then: (manager: PaneManager) => void
): void {
  const equalize = (): void => {
    const manager = pane.getManager()
    if (manager) {
      manager.equalizePaneSizes()
      then(manager)
    }
  }
  // Switch point: main equalizes the tab; the window takes the sizes from main's frame.
  if (
    ORCA_LAYOUT_OWNER_IS_MAIN &&
    sendLayoutCommandToOwner(
      pane.worktreeId,
      { type: 'equalizePanes', tabId: pane.tabId },
      {
        // No frame is coming (the stream is down): the window equalizes itself, as main did.
        apply: (_result, origin) => {
          const manager = pane.getManager()
          if (!origin.routed && !layoutFramesFlowing(origin.framesKey)) {
            equalize()
          } else if (manager) {
            then(manager)
          }
        },
        asToday: equalize
      }
    )
  ) {
    return
  }
  equalize()
}
