import type { PreloadApi } from '../../../../../preload/api-types'
import { noopUnsubscribe } from '../web-storage'

export function createWebUiNativeWindowApi() {
  return {
    // Why: a paired web client has no OS sleep signal; occlusion-driven visibilitychange already covers wake recovery.
    onSystemResumed: () => noopUnsubscribe,
    syncTrafficLights: () => {},
    setMarkdownEditorFocused: () => {},
    setRichMarkdownContextMenuTarget: () => {},
    markPlainTextContextMenuTarget: () => {},
    setTerminalInputFocused: () => {},
    setFloatingFocus: () => {},
    setShortcutRecorderFocused: () => {},
    onRichMarkdownContextCommand: () => noopUnsubscribe,
    onFullscreenChanged: () => noopUnsubscribe,
    minimize: () => {},
    maximize: () => {},
    onMaximizeChanged: () => noopUnsubscribe,
    onWindowActiveChanged: () => noopUnsubscribe,
    requestClose: () => {},
    popupMenu: () => {},
    onWindowCloseRequested: () => noopUnsubscribe,
    confirmWindowClose: () => {},
    cancelWindowClose: () => {},
    notifyWindowRevealed: () => {}
  } satisfies Partial<PreloadApi['ui']>
}
