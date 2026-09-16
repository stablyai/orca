import { useCallback, useState } from 'react'
import type { ManagedPane } from '@/lib/pane-manager/pane-manager'
import { isPtyLocked } from '@/lib/pane-manager/mobile-driver-state'
import {
  submitTerminalRichInput,
  type TerminalRichInputSubmitResult
} from './terminal-rich-input-submit'
import type { TerminalPaneTitleController } from './use-terminal-pane-title-state'

export function useTerminalPaneRichInput(
  controller: TerminalPaneTitleController,
  effectiveChatViewMode: boolean
) {
  const { managerRef, paneTransportsRef, tabId, worktreeId } = controller
  const [richInputLeafId, setRichInputLeafId] = useState<string | null>(null)
  const closeRichInput = useCallback(() => {
    setRichInputLeafId(null)
    requestAnimationFrame(() => {
      const manager = managerRef.current
      const pane = manager?.getActivePane() ?? manager?.getPanes()[0]
      pane?.terminal.focus()
    })
  }, [managerRef])
  const toggleRichInput = useCallback(() => {
    if (effectiveChatViewMode) {
      return
    }
    const activeLeafId = managerRef.current?.getActivePane()?.leafId ?? null
    if (!activeLeafId) {
      return
    }
    if (richInputLeafId === activeLeafId) {
      closeRichInput()
      return
    }
    setRichInputLeafId(activeLeafId)
  }, [closeRichInput, effectiveChatViewMode, managerRef, richInputLeafId])
  const submitRichInputForPane = useCallback(
    async (
      pane: ManagedPane,
      text: string,
      imagePaths: string[]
    ): Promise<TerminalRichInputSubmitResult> => {
      const transport = paneTransportsRef.current.get(pane.id)
      const ptyId = transport?.getPtyId() ?? null
      if (ptyId && isPtyLocked(ptyId)) {
        return { status: 'not-started' }
      }
      return await submitTerminalRichInput({
        text,
        imagePaths,
        tabId,
        worktreeId,
        pane,
        transport,
        getManager: () => managerRef.current,
        getPaneTransports: () => paneTransportsRef.current
      })
    },
    [managerRef, paneTransportsRef, tabId, worktreeId]
  )
  return {
    richInputLeafId,
    setRichInputLeafId,
    closeRichInput,
    toggleRichInput,
    submitRichInputForPane
  }
}
