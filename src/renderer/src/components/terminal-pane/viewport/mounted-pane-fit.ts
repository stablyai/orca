import type { PaneManager } from '@/lib/pane-manager/pane-manager'
import { focusActivePane } from '../input/focus/mounted-pane-focus'

export function fitPanes(manager: PaneManager): void {
  manager.fitAllPanes()
}

export function fitAndFocusPanes(manager: PaneManager): void {
  fitPanes(manager)
  focusActivePane(manager)
}

/** Coalesce same-turn resizes without dropping a focus request a later fit-only call would cancel. */
export function createQueuedPaneResize(run: (focusActive: boolean) => void): {
  queue: (focusActive: boolean) => void
  cancel: () => void
} {
  let handle: number | null = null
  let focusActive = false
  return {
    queue(next) {
      focusActive = focusActive || next
      if (handle !== null) {
        cancelAnimationFrame(handle)
      }
      handle = requestAnimationFrame(() => {
        handle = null
        const focus = focusActive
        focusActive = false
        run(focus)
      })
    },
    cancel() {
      if (handle !== null) {
        cancelAnimationFrame(handle)
        handle = null
      }
      focusActive = false
    }
  }
}
