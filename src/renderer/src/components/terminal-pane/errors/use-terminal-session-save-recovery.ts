import { useCallback } from 'react'
import type { TerminalPaneStoreController } from '../controller/use-terminal-pane-store-bindings'

export function useTerminalSessionSaveRecovery({
  setSessionStateSaveFailureMessage,
  openSpacePage,
  refreshWorkspaceSpace
}: Pick<
  TerminalPaneStoreController,
  'setSessionStateSaveFailureMessage' | 'openSpacePage' | 'refreshWorkspaceSpace'
>) {
  const openDiskSpaceAnalyzer = useCallback(() => {
    setSessionStateSaveFailureMessage(null)
    openSpacePage()
    void refreshWorkspaceSpace().catch((error: unknown) => {
      console.warn('Failed to refresh Space Analyzer after terminal session save failure:', error)
    })
  }, [openSpacePage, refreshWorkspaceSpace, setSessionStateSaveFailureMessage])
  return { openDiskSpaceAnalyzer }
}
