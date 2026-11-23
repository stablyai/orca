import type { ClientWorkspaceViewReporter } from '@/attention/client-workspace-view-report'
import type { AutoAckTabTarget } from '@/attention/agent-auto-ack-targets'
import type { AppState } from '@/store/types'
import { structuredAgentSessionTargetForTab } from '@/runtime/native-chat/session-ownership/structured-agent-session-owner'
import { readBotBackgroundSessionTabs } from '@/components/bots/bot-background-sessions'
import {
  findTabByIdOrChatAlias,
  isStructuredTab
} from '../../../../shared/agent-session/view/structured-agent-session-tab'
import {
  collectLayoutLeafIdsInOrder,
  resolveRootlessTerminalLayoutLeafId
} from '../../../../shared/workspace-layout/terminal-topology/terminal-pane-tree'
import { makePaneKey } from '../../../../shared/workspace-layout/stable-pane-id'
import { notchPaneKeyForSubject } from './notch-session-identity'

function viewedPaneKeys(state: AppState, targets: readonly AutoAckTabTarget[]): string[] {
  const keys = new Set<string>()
  for (const target of targets) {
    if (!target.worktreeId) {
      continue
    }
    if (target.surfaceKind === 'structured') {
      const tab =
        findTabByIdOrChatAlias(state.unifiedTabsByWorktree[target.worktreeId], target.tabId) ??
        findTabByIdOrChatAlias(readBotBackgroundSessionTabs(), target.tabId)
      const owner =
        tab && isStructuredTab(tab) ? structuredAgentSessionTargetForTab(state, tab) : null
      if (tab && owner) {
        const key = notchPaneKeyForSubject(state, '', { sessionId: tab.entityId, target: owner })
        if (key) {
          keys.add(key)
        }
      }
      continue
    }
    const layout = state.terminalLayoutsByTabId[target.tabId]
    if (!layout) {
      continue
    }
    const rootlessLeaf = resolveRootlessTerminalLayoutLeafId(layout)
    const leaves = layout.expandedLeafId
      ? [layout.expandedLeafId]
      : layout.root
        ? collectLayoutLeafIdsInOrder(layout.root)
        : rootlessLeaf
          ? [rootlessLeaf]
          : []
    for (const leaf of leaves) {
      const key = notchPaneKeyForSubject(state, makePaneKey(target.tabId, leaf))
      if (key) {
        keys.add(key)
      }
    }
  }
  return [...keys].sort()
}

/** Share the attention scan's foreground/split targets without acknowledging the hidden rows. */
export function createNotchViewReporter(
  base?: ClientWorkspaceViewReporter
): ClientWorkspaceViewReporter & { invalidate: () => void } {
  let lastSignature: string | null = null
  return {
    invalidate: () => {
      lastSignature = null
    },
    update: (state, workspaceIds, targets) => {
      base?.update(state, workspaceIds, targets)
      const keys = viewedPaneKeys(state, targets)
      const signature = JSON.stringify(keys)
      if (signature !== lastSignature) {
        lastSignature = signature
        window.api.notch?.setViewedPanes(keys)
      }
    },
    renewPresence: () => base?.renewPresence()
  }
}
