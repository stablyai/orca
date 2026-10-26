import { getAgentStatusState } from '@/store/agent-status'

import type { CloseTerminalDialogCopyKind } from '../terminal-pane/CloseTerminalDialog'
import { isTerminalLeafId, makePaneKey } from '../../../../shared/stable-pane-id'

/** Share agent classification across pane- and PTY-scoped close prompts so identical closes use identical copy. */
export function resolveLeafCloseCopyKind(
  tabId: string,
  leafId: string | null | undefined
): CloseTerminalDialogCopyKind {
  // Legacy/mid-attach leaf IDs may fail makePaneKey; confirmation must not break close.
  if (!leafId || !isTerminalLeafId(leafId) || !tabId || tabId.includes(':')) {
    return 'command'
  }
  const agentStatusByPaneKey = getAgentStatusState().agentStatusByPaneKey ?? {}
  const agentType = agentStatusByPaneKey[makePaneKey(tabId, leafId)]?.agentType
  return agentType && agentType !== 'unknown' ? 'agent' : 'command'
}

/** Agent copy wins mixed splits because stopping an agent mid-task is the costlier surprise. */
export function resolveBusyPtyCloseCopyKind(
  tabId: string,
  busyPtyIds: readonly string[]
): CloseTerminalDialogCopyKind {
  const ptyIdsByLeafId = getAgentStatusState().terminalLayoutsByTabId?.[tabId]?.ptyIdsByLeafId ?? {}
  for (const [leafId, ptyId] of Object.entries(ptyIdsByLeafId)) {
    if (busyPtyIds.includes(ptyId) && resolveLeafCloseCopyKind(tabId, leafId) === 'agent') {
      return 'agent'
    }
  }
  return 'command'
}
