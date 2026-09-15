import type { PaneManager } from '@/lib/pane-manager/pane-manager'
import type { PtyTransport } from './pty-transport'
import { handleNativeTerminalFileDrop } from './terminal-native-file-drop'

export type PasteClipboardFilePathsArgs = {
  manager: PaneManager | null
  paneTransports: Map<number, PtyTransport>
  worktreeId: string
  tabId: string
  cwd: string | undefined
  paneLeafId: string
  paths: string[]
}

/**
 * Paste files copied in an OS file manager into a terminal pane by reusing the
 * native drop pipeline, so a pasted file behaves exactly like a dropped one:
 * local paths stay in place, SSH and runtime worktrees upload into
 * `.orca/drops` first, and every path lands shell-escaped for the target shell.
 */
export async function pasteClipboardFilePathsIntoTerminal({
  manager,
  paneTransports,
  worktreeId,
  tabId,
  cwd,
  paneLeafId,
  paths
}: PasteClipboardFilePathsArgs): Promise<boolean> {
  if (!manager || paths.length === 0) {
    return false
  }
  await handleNativeTerminalFileDrop({
    manager,
    paneTransports,
    worktreeId,
    tabId,
    cwd,
    data: { paths, target: 'terminal', paneLeafId }
  })
  return true
}
