import { isFloatingWorkspacePanelFocused } from '@/components/floating-terminal/workspace/floating-workspace-terminal-actions'
import {
  resolveActiveFileToRevealInExplorer,
  revealActiveFileInExplorer
} from '@/components/right-sidebar/file-explorer/navigation/active-file-explorer-reveal'
import { useAppStore } from '../../store/index'
import type { KeybindingActionId } from '../../../../shared/keybindings/types'

export function revealActiveFileShortcut(
  canRevealRightSidebar: boolean,
  claim: (actionId: KeybindingActionId, run: () => void) => boolean
): () => boolean {
  return () => {
    if (!canRevealRightSidebar || isFloatingWorkspacePanelFocused()) {
      return false
    }
    if (!resolveActiveFileToRevealInExplorer(useAppStore.getState())) {
      return false
    }
    return claim('fileExplorer.revealActiveFile', () => {
      revealActiveFileInExplorer(useAppStore.getState())
    })
  }
}
