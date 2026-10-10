import { shouldFollowMouseFocus } from '../focus-follows-mouse'

type MouseFocusPaneManager = {
  getActivePane: () => { id: number } | null
  setActivePane: (paneId: number, opts: { focus: boolean }) => void
}

// Focus-follows-mouse for pointer entry the pane's DOM never sees under its native view; the
// same gate as the pane container's mouseenter, with window focus reported by AppKit.
export function followNativePaneMouseFocus(
  manager: MouseFocusPaneManager,
  paneId: number,
  pointer: { mouseButtons: number; windowHasFocus: boolean },
  featureEnabled: boolean
): void {
  if (
    shouldFollowMouseFocus({
      featureEnabled,
      activePaneId: manager.getActivePane()?.id ?? null,
      hoveredPaneId: paneId,
      mouseButtons: pointer.mouseButtons,
      windowHasFocus: pointer.windowHasFocus,
      // Native events stop with the pane: disposal detaches its surface first.
      managerDestroyed: false
    })
  ) {
    manager.setActivePane(paneId, { focus: true })
  }
}
