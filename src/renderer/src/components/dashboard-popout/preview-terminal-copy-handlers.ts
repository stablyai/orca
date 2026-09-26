import type { IDisposable, Terminal } from '@xterm/xterm'
import { installTerminalNativeCopyGutterTrim } from '@/components/terminal-pane/terminal-native-copy-gutter'
import { installTerminalSelectionCopyHandler } from '@/components/terminal-pane/terminal-selection-copy-event'

export function installPreviewTerminalCopyHandlers(terminal: Terminal): IDisposable {
  const selectionCopy = installTerminalSelectionCopyHandler(
    terminal,
    window.api.ui.writeTerminalClipboardText
  )
  const nativeCopyGutterTrim = installTerminalNativeCopyGutterTrim(terminal)
  return {
    dispose: () => {
      selectionCopy.dispose()
      nativeCopyGutterTrim.dispose()
    }
  }
}
