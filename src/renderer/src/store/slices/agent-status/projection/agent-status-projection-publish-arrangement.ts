import type { DashboardAgentRow } from '@/components/dashboard/rows/dashboard-agent-row'
import { resolveNativeChatActiveLayoutLeafId } from '@/components/native-chat/pane/routing/native-chat-leaf-routing'
import { isTerminalTabWideFallbackSafe as isNativeChatTabWideFallbackSafe } from '../../../../../../shared/agent-status/mobile-terminal-status-shaping'
import type { AppState } from '../../../types'
import { compareWorktreeAgentRows } from '@/components/sidebar/workspace-card/activity/worktree-agent-row-order'
import { structuralValuesEqualIgnoringUndefined as equal } from '../../../../../../shared/collections/structural-value-equality'
import { applyAgentRowLineage } from '@/components/dashboard/rows/agent-row-lineage'
import type { AgentStatusProjectionState } from './agent-status-projection-state'
import type { ProjectionTopology } from './agent-status-projection-topology'
import type { ProjectionRows } from './agent-status-projection-rows'

function sameStringArray(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) {
    return false
  }
  for (let i = 0; i < left.length; i += 1) {
    if (left[i] !== right[i]) {
      return false
    }
  }
  return true
}

export function publishProjectionArrangement(
  data: AgentStatusProjectionState,
  state: AppState,
  topology: ProjectionTopology,
  rows: ProjectionRows,
  { arrange, cleanup }: { arrange: Set<string>; cleanup: Set<string> }
): void {
  const { changedTabs } = topology
  const { prepared } = rows
  let changedIdentity = false
  let identityTabs: ReadonlySet<string>
  if (prepared.size === 0) {
    identityTabs = changedTabs
  } else {
    const combined = new Set<string>(changedTabs)
    for (const row of prepared.values()) {
      if (row.tabId) {
        combined.add(row.tabId)
      }
    }
    identityTabs = combined
  }
  for (const tabId of identityTabs) {
    const layout = state.terminalLayoutsByTabId[tabId]
    const leaf =
      layout && (layout.root || layout.activeLeafId)
        ? resolveNativeChatActiveLayoutLeafId(layout)
        : null
    const firstKey = data.acceptedByTab.get(tabId)?.values().next().value
    const agentType = leaf
      ? state.agentStatusByPaneKey.get(`${tabId}:${leaf}`)?.agentType
      : layout && (layout.root || layout.activeLeafId)
        ? undefined
        : firstKey
          ? state.agentStatusByPaneKey.get(firstKey)?.agentType
          : undefined
    const unsafe = layout && !isNativeChatTabWideFallbackSafe(layout) ? true : undefined
    if (data.tabTypes[tabId] !== agentType || data.unsafeTabs[tabId] !== unsafe) {
      changedIdentity = true
      if (agentType) {
        data.tabTypes[tabId] = agentType
      } else {
        delete data.tabTypes[tabId]
      }
      if (unsafe) {
        data.unsafeTabs[tabId] = unsafe
      } else {
        delete data.unsafeTabs[tabId]
      }
    }
  }
  if (changedIdentity) {
    data.tabProjection = { ...data.tabProjection, revision: data.tabProjection.revision + 1 }
  }
  for (const owner of arrange) {
    data.touchedWorktrees.add(owner)
    const b = data.worktrees.get(owner)!
    const sortedRows: DashboardAgentRow[] = []
    for (const key of b.keys) {
      sortedRows.push(data.rows.get(key)!)
    }
    sortedRows.sort(compareWorktreeAgentRows)
    const rows = applyAgentRowLineage(sortedRows)
    const keys: string[] = []
    for (let i = 0; i < rows.length; i += 1) {
      const row = rows[i]
      keys.push(row.paneKey)
      const previous = data.rows.get(row.paneKey)!
      if (!equal(previous.lineage, row.lineage)) {
        data.rows.set(row.paneKey, row)
        data.notices.add(`row\0${row.paneKey}`)
      }
    }
    if (!sameStringArray(b.arrangement, keys)) {
      b.arrangement = keys
    }
    const changedChildren = data.display.arrange(owner, rows)
    data.notices.add(`keys\0${owner}`)
    data.notices.add(`roots\0${owner}`)
    data.notices.add(`groups\0${owner}`)
    for (const key of changedChildren) {
      data.notices.add(`children\0${key}`)
    }
  }
  for (const [, next] of prepared) {
    if (next.worktreeId && !arrange.has(next.worktreeId)) {
      for (const row of next.rows) {
        const parents = data.display.update(row.paneKey, row)
        for (const parent of parents) {
          data.notices.add(`children\0${parent}`)
        }
        if (!row.lineage?.parentPaneKey) {
          data.notices.add(`groups\0${next.worktreeId}`)
        }
      }
    }
  }
  for (const owner of cleanup) {
    const b = data.worktrees.get(owner)
    if (b && !b.keys.size && !b.counts.size) {
      data.worktrees.delete(owner)
      data.touchedWorktrees.add(owner)
      data.fullRows.delete(owner)
    }
  }
}
