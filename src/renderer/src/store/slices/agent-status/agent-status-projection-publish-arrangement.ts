import {
  isNativeChatTabWideFallbackSafe,
  resolveNativeChatActiveLayoutLeafId
} from '@/components/native-chat/pane/routing/native-chat-leaf-routing'
import type { AppState } from '../../types'
import { compareWorktreeAgentRows } from '@/components/sidebar/workspace-card/activity/worktree-agent-row-order'
import { structuralValuesEqualIgnoringUndefined as equal } from '../../../../../shared/structural-value-equality'
import { applyAgentRowLineage } from '@/components/dashboard/agent-row-lineage'
import type { AgentStatusProjectionState } from './agent-status-projection-state'
import type { ProjectionTopology } from './agent-status-projection-topology'
import type { ProjectionRows } from './agent-status-projection-rows'

export function publishProjectionArrangement(
  data: AgentStatusProjectionState,
  state: AppState,
  topology: ProjectionTopology,
  rows: ProjectionRows,
  arrange: Set<string>
): void {
  const { changedTabs } = topology
  const { prepared } = rows
  let changedIdentity = false
  const identityTabs = new Set([
    ...changedTabs,
    ...[...prepared.values()].flatMap((row) => (row.tabId ? [row.tabId] : []))
  ])
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
    const b = data.worktrees.get(owner)!
    const rows = applyAgentRowLineage(
      [...b.keys].map((key) => data.rows.get(key)!).sort(compareWorktreeAgentRows)
    )
    for (const row of rows) {
      const previous = data.rows.get(row.paneKey)!
      if (!equal(previous.lineage, row.lineage)) {
        data.rows.set(row.paneKey, row)
        data.notices.add(`row\0${row.paneKey}`)
      }
    }
    const keys = rows.map((row) => row.paneKey)
    if (!equal(b.arrangement, keys)) {
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
  for (const owner of new Set([
    ...arrange,
    ...[...prepared.values()].flatMap((row) => (row.worktreeId ? [row.worktreeId] : []))
  ])) {
    const b = data.worktrees.get(owner)
    if (b && !b.keys.size && !b.counts.size) {
      data.worktrees.delete(owner)
      data.fullRows.delete(owner)
    }
  }
}
