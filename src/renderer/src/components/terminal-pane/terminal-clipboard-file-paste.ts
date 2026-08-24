import type { ManagedPane, PaneManager } from '@/lib/pane-manager/pane-manager'
import { NATIVE_FILE_DROP_TARGET } from '../../../../shared/native-file-drop'
import type { PtyTransport } from './pty-transport'
import { pasteNativeTerminalFileDrop } from './terminal-native-file-drop'

export async function pasteTerminalClipboardFilePaths({
  manager,
  pane,
  paneTransports,
  paths,
  tabId,
  worktreeId,
  cwd
}: {
  manager: PaneManager | null
  pane: ManagedPane
  paneTransports: Map<number, PtyTransport>
  paths: string[]
  tabId: string
  worktreeId: string
  cwd?: string
}): Promise<boolean> {
  if (!manager || !paneTransports.has(pane.id)) {
    return false
  }
  return pasteNativeTerminalFileDrop({
    manager,
    paneTransports,
    worktreeId,
    tabId,
    cwd,
    data: {
      paths,
      target: NATIVE_FILE_DROP_TARGET.terminal,
      tabId,
      paneLeafId: pane.leafId
    }
  })
}
