import { useEffect } from 'react'
import type { PaneManager } from '@/lib/pane-manager/pane-manager'
import { onSessionTabScroll } from '@/lib/workspace/tabs/session-tab-scroll-event'

/** Scrolls a visible pane as a wheel over it would, so fullscreen TUIs get wheel reports and shells scroll scrollback. */
export function useTerminalPaneScrollEvent({
  tabId,
  managerRef,
  isVisibleRef
}: {
  tabId: string
  managerRef: React.RefObject<PaneManager | null>
  isVisibleRef: React.RefObject<boolean>
}): void {
  useEffect(
    () =>
      onSessionTabScroll(tabId, ({ leafId, deltaY }) => {
        const manager = managerRef.current
        if (!manager || !isVisibleRef.current || deltaY === 0) {
          return false
        }
        const numericId = leafId ? manager.getNumericIdForLeaf(leafId) : null
        // A named leaf this tab no longer has must not scroll a different pane.
        const pane = leafId
          ? manager.getPanes().find((p) => p.id === numericId)
          : (manager.getActivePane() ?? manager.getPanes()[0])
        const screen =
          pane?.terminal.element?.querySelector<HTMLElement>('.xterm-screen') ??
          pane?.terminal.element
        if (!screen) {
          return false
        }
        const rect = screen.getBoundingClientRect()
        // A terminal tab shown as chat keeps its pane mounted but unlaid; the chat view answers then.
        if (rect.width === 0 || rect.height === 0) {
          return false
        }
        const wheel = new WheelEvent('wheel', {
          deltaY,
          deltaMode: WheelEvent.DOM_DELTA_PIXEL,
          // Mouse-reporting TUIs read the pointer cell; aim at the pane's center.
          clientX: rect.left + rect.width / 2,
          clientY: rect.top + rect.height / 2,
          bubbles: true,
          cancelable: true
        })
        // Why: xterm's viewport reads legacy wheelDeltaY, which Chromium gives a constructed event with
        // deltaY's sign; a trusted wheel carries -1.2 × deltaY, so without this the viewport scrolls backward.
        const legacyDelta = -deltaY * 1.2
        Object.defineProperty(wheel, 'wheelDeltaY', { value: legacyDelta })
        Object.defineProperty(wheel, 'wheelDelta', { value: legacyDelta })
        screen.dispatchEvent(wheel)
        return true
      }),
    [tabId, managerRef, isVisibleRef]
  )
}
