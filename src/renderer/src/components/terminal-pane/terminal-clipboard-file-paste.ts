import type { ManagedPane, PaneManager } from '@/lib/pane-manager/pane-manager'
import { NATIVE_FILE_DROP_TARGET } from '../../../../shared/native-file-drop'
import type { PtyTransport } from './pty-transport'
import { handleNativeTerminalFileDrop } from './terminal-native-file-drop'

// Why: a copied file pastes exactly like a dropped one — shell-escaped for local
// worktrees, uploaded first for SSH and runtime worktrees.
export function pasteClipboardFilePathsToPane(args: {
  manager: PaneManager | null
  paneTransports: Map<number, PtyTransport>
  worktreeId: string
  tabId: string
  cwd: string | undefined
  pane: ManagedPane
}): ((paths: string[]) => Promise<void>) | undefined {
  const { manager, paneTransports, worktreeId, tabId, cwd, pane } = args
  if (!manager) {
    return undefined
  }
  return (paths) =>
    handleNativeTerminalFileDrop({
      manager,
      paneTransports,
      worktreeId,
      tabId,
      cwd,
      data: { paths, target: NATIVE_FILE_DROP_TARGET.terminal, paneLeafId: pane.leafId }
    })
}
