import { useEffect } from 'react'
import { createTerminalPanePasteExecution } from './terminal-pane-paste-execution'
import { registerTerminalPanePasteListeners } from './terminal-pane-paste-listeners'
import type { TerminalPaneMountedController } from '../../mounting/use-terminal-pane-lifecycle-stage'

export function useTerminalPanePasteListeners(controller: TerminalPaneMountedController): void {
  const {
    terminalManager,
    containerRef,
    forceBracketedMultilineTextPaste,
    isActive,
    keybindings,
    tabId,
    worktreeId
  } = controller

  useEffect(() => {
    if (!isActive || !terminalManager) {
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
  }, [terminalManager, isActive, worktreeId, keybindings, forceBracketedMultilineTextPaste, tabId])
}
