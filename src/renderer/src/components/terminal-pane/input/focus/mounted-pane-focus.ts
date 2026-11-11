import type { PaneManager } from '@/lib/pane-manager/pane-manager'
import { focusPanePreservingOverlays } from '@/lib/pane-manager/pane-overlay-focus'
import { shouldPreserveEditableFocus } from '../../../../lib/text-input/focus/editable-focus-preservation'

export function focusActivePane(manager: PaneManager): void {
  // Tab rename focuses next frame; queued layout focus must not blur it closed first.
  if (typeof document !== 'undefined' && document.querySelector('[data-tab-rename-input="true"]')) {
    return
  }
  const activeElement = typeof document === 'undefined' ? null : document.activeElement
  if (shouldPreserveEditableFocus(activeElement)) {
    return
  }
  const panes = manager.getPanes()
  const activePane = manager.getActivePane() ?? panes[0]
  if (activePane) {
    focusPanePreservingOverlays(activePane)
  }
}
