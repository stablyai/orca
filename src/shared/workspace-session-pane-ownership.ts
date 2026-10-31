/** Share persisted-pane/editor ownership across source export, destination validation and profile transfer. */
import type { SleepingAgentSessionRecord } from './agent-session-resume'
import type { TerminalPaneLayoutNode } from './terminal-tab-types'
import type { WorkspaceSessionState } from './workspace-session-state-types'

// Split at the last colon like destination validation; prefix matching would accept keys it rejects.
export function paneBelongsToTabs(paneKey: string, tabIds: ReadonlySet<string>): boolean {
  const separator = paneKey.lastIndexOf(':')
  return separator > 0 && tabIds.has(paneKey.slice(0, separator))
}

export function paneBelongsToTerminalLayout(
  record: Pick<SleepingAgentSessionRecord, 'paneKey' | 'tabId'>,
  session: WorkspaceSessionState,
  terminalTabIds: ReadonlySet<string>
): boolean {
  const separator = record.paneKey.lastIndexOf(':')
  if (separator < 1) {
    return false
  }
  const tabId = record.paneKey.slice(0, separator)
  const leafId = record.paneKey.slice(separator + 1)
  if ((record.tabId !== undefined && record.tabId !== tabId) || !terminalTabIds.has(tabId)) {
    return false
  }
  return terminalLayoutContainsLeaf(session.terminalLayoutsByTabId[tabId]?.root, leafId)
}

export function terminalLayoutContainsLeaf(
  node: TerminalPaneLayoutNode | null | undefined,
  leafId: string
): boolean {
  if (!node) {
    return false
  }
  return node.type === 'leaf'
    ? node.leafId === leafId
    : terminalLayoutContainsLeaf(node.first, leafId) ||
        terminalLayoutContainsLeaf(node.second, leafId)
}

export function ownedEditorFileId(
  filePath: string,
  worktreeId: string,
  runtimeEnvironmentId: string | null | undefined
): string {
  const runtimeKey = runtimeEnvironmentId?.trim() || 'local'
  return `editor:${encodeURIComponent(worktreeId)}:${encodeURIComponent(runtimeKey)}:${encodeURIComponent(filePath)}`
}
