import { useEffect } from 'react'
import { createTerminalPanePasteExecution } from './terminal-pane-paste-execution'
import { registerTerminalPanePasteListeners } from './terminal-pane-paste-listeners'
import type { TerminalPaneCloseController } from './use-terminal-pane-close-actions'

export function useTerminalPanePasteListeners(controller: TerminalPaneCloseController): void {
  const {
    containerRef,
    forceBracketedMultilineTextPaste,
    isActive,
    keybindings,
    tabId,
    worktreeId
  } = controller

  useEffect(() => {
    if (!isActive) {
      return
    }
    const container = containerRef.current
    if (!container) {
      return
    }
    const isMac = navigator.userAgent.includes('Mac')
    const shortcutPlatform: NodeJS.Platform = isMac
      ? 'darwin'
      : navigator.userAgent.includes('Windows')
        ? 'win32'
        : 'linux'
    const execution = createTerminalPanePasteExecution(controller, shortcutPlatform)
    return registerTerminalPanePasteListeners({
      container,
      controller,
      execution,
      isMac,
      shortcutPlatform
    })
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- Preserve the pre-split dependency contract.
  }, [isActive, worktreeId, keybindings, forceBracketedMultilineTextPaste, tabId])
}
