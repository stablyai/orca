import type { PaneManager } from '@/lib/pane-manager/pane-manager'
import { focusActivePane } from '../input/focus/mounted-pane-focus'

export function fitPanes(manager: PaneManager): void {
  manager.fitAllPanes()
}

export function fitAndFocusPanes(manager: PaneManager): void {
  fitPanes(manager)
  focusActivePane(manager)
}
