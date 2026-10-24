import { useAppStore } from '../../store'

// Why: macOS delivers back/forward swipes only to the main process; this gives them the same
// behavior as the mouse side buttons (3/4) on Linux and Windows.
export function registerSwipeNavigationIpcBridge(unsubs: (() => void)[]): void {
  unsubs.push(
    window.api.ui.onSwipeNavigate((direction) => {
      // Why: a swipe has no target, like a key press; follow the pointer, since a hidden browser page can keep focus.
      const page = document.querySelector<Electron.WebviewTag>('webview:hover')
      if (page) {
        if (direction === 'back') {
          page.goBack()
        } else {
          page.goForward()
        }
        return
      }
      const remoteFrame = document.querySelector('[data-testid="remote-browser-frame"]:hover')
      if (remoteFrame) {
        // Why: wrap the swipe as the side-button click the remote pane already turns into remote back/forward.
        remoteFrame.dispatchEvent(
          new PointerEvent('pointerdown', { bubbles: true, button: direction === 'back' ? 3 : 4 })
        )
        return
      }
      const store = useAppStore.getState()
      if (store.activeView !== 'terminal') {
        return
      }
      if (direction === 'back') {
        store.goBackWorktree()
      } else {
        store.goForwardWorktree()
      }
    })
  )
}
