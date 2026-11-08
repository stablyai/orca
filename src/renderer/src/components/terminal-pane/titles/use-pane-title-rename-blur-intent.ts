import { useEffect } from 'react'
import type { TerminalPaneCloseController } from '../layout/close/use-terminal-pane-close-actions'

export function usePaneTitleRenameBlurIntent({
  renamingPaneId,
  renameInputRef,
  renameUserRequestedBlurCommitRef
}: Pick<
  TerminalPaneCloseController,
  'renamingPaneId' | 'renameInputRef' | 'renameUserRequestedBlurCommitRef'
>): void {
  useEffect(() => {
    if (renamingPaneId === null) {
      return
    }
    const markPointerBlurIntent = (event: PointerEvent): void => {
      const input = renameInputRef.current
      const target = event.target
      if (input && target instanceof Node && input.contains(target)) {
        return
      }
      renameUserRequestedBlurCommitRef.current = true
    }
    const markKeyboardBlurIntent = (event: KeyboardEvent): void => {
      if (event.key === 'Tab') {
        renameUserRequestedBlurCommitRef.current = true
      }
    }
    document.addEventListener('pointerdown', markPointerBlurIntent, true)
    document.addEventListener('keydown', markKeyboardBlurIntent, true)
    return () => {
      document.removeEventListener('pointerdown', markPointerBlurIntent, true)
      document.removeEventListener('keydown', markKeyboardBlurIntent, true)
    }
  }, [renamingPaneId, renameInputRef, renameUserRequestedBlurCommitRef])
}
