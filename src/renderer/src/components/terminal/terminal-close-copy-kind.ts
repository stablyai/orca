import { useAppStore } from '@/store'
import type { CloseTerminalDialogCopyKind } from '../terminal-pane/CloseTerminalDialog'
import { isTerminalLeafId, makePaneKey } from '../../../../shared/stable-pane-id'

/**
 * Single source of truth for "is this pane an agent?" in the close confirmation, so the
 * keyboard (pane-scoped) and tab-strip (pty-scoped) prompts cannot word the same close
 * differently. Each caller resolves its own leaf id; only the policy is shared.
 */
export function resolveLeafCloseCopyKind(
  tabId: string,
  leafId: string | null | undefined
): CloseTerminalDialogCopyKind {
  // Why: legacy layouts and mid-attach panes carry non-UUID or missing leaf ids, and
  // makePaneKey throws on those — a dialog must never be the thing that breaks a close.
  if (!leafId || !isTerminalLeafId(leafId) || !tabId || tabId.includes(':')) {
    return 'command'
  }
  const agentStatusByPaneKey = useAppStore.getState().agentStatusByPaneKey ?? {}
  const agentType = agentStatusByPaneKey[makePaneKey(tabId, leafId)]?.agentType
  return agentType && agentType !== 'unknown' ? 'agent' : 'command'
}

/** Copy for a whole-tab close, given the PTYs that reported a live child. Agent panes win
 *  in a mixed split: stopping an agent mid-task is the costlier surprise. */
export function resolveBusyPtyCloseCopyKind(
  tabId: string,
  busyPtyIds: readonly string[]
): CloseTerminalDialogCopyKind {
  const ptyIdsByLeafId =
    useAppStore.getState().terminalLayoutsByTabId?.[tabId]?.ptyIdsByLeafId ?? {}
  for (const [leafId, ptyId] of Object.entries(ptyIdsByLeafId)) {
    if (busyPtyIds.includes(ptyId) && resolveLeafCloseCopyKind(tabId, leafId) === 'agent') {
      return 'agent'
    }
  }
  return 'command'
}
