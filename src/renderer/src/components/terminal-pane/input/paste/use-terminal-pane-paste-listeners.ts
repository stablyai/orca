import { useEffect, useMemo } from 'react'
import { createClipboardImagePasteEnterHold } from './clipboard-image-paste-enter-hold'
import { createTerminalPanePasteExecution } from './terminal-pane-paste-execution'
import { registerTerminalPanePasteListeners } from './terminal-pane-paste-listeners'
import type { TerminalPaneMountedController } from '../../mounting/use-terminal-pane-lifecycle-stage'

export function useTerminalPanePasteListeners(controller: TerminalPaneMountedController) {
  const {
    terminalManager,
    containerRef,
    forceBracketedMultilineTextPaste,
    isActive,
    keybindings,
    tabId,
    worktreeId
  } = controller

  // Shared with the context-menu paste path: one hold per tab covers every paste entry point (#41502).
  // Keyed on the manager: the controller object itself is new every render.
  const clipboardImageEnterHold = useMemo(
    () =>
      createClipboardImagePasteEnterHold({
        getPanes: () => terminalManager?.getPanes()
      }),
    [terminalManager]
  )

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
    const execution = createTerminalPanePasteExecution(
      controller,
      shortcutPlatform,
      clipboardImageEnterHold
    )
    return registerTerminalPanePasteListeners({
      container,
      controller,
      execution,
      isMac,
      shortcutPlatform
    })
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- Preserve the pre-split dependency contract.
  }, [terminalManager, isActive, worktreeId, keybindings, forceBracketedMultilineTextPaste, tabId])

  return { clipboardImageEnterHold }
}
