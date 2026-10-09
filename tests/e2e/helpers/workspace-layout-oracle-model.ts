/**
 * The workspace tab layout reduced to what every view must agree on: groups and their tab order,
 * terminal tabs, their panes in tree order, which terminal each pane shows, and custom titles.
 * Per-viewer state (selection, focus, sizes, scroll) is left out on purpose.
 */

import type { ExecutionHostId } from '../../../src/shared/execution-host'
import type { TerminalPaneLayoutNode } from '../../../src/shared/terminal-tab-types'
import type { WorkspaceSessionState } from '../../../src/shared/workspace-session-state-types'
import {
  checkWorkspaceLayoutRules,
  type WorkspaceLayoutPartition,
  type WorkspaceLayoutViolation
} from '../../../src/shared/workspace-layout/workspace-layout-rules'

export type OraclePane = { leafId: string; ptyId: string | null }
export type OracleTerminalTab = { id: string; customTitle: string | null; panes: OraclePane[] }
export type OracleGroup = { id: string; tabOrder: string[] }
export type OracleWorktreeLayout = { groups: OracleGroup[]; terminalTabs: OracleTerminalTab[] }
/** Keyed by `${hostId}|${worktreeId}`. */
export type OracleLayout = Record<string, OracleWorktreeLayout>

export function oracleWorktreeKey(hostId: ExecutionHostId, worktreeId: string): string {
  return `${hostId}|${worktreeId}`
}

export function leafIdsInOrder(node: TerminalPaneLayoutNode | null | undefined): string[] {
  if (!node) {
    return []
  }
  return node.type === 'leaf'
    ? [node.leafId]
    : [...leafIdsInOrder(node.first), ...leafIdsInOrder(node.second)]
}

function worktreeLayout(session: WorkspaceSessionState, worktreeId: string): OracleWorktreeLayout {
  return {
    groups: (session.tabGroups?.[worktreeId] ?? []).map((group) => ({
      id: group.id,
      tabOrder: [...group.tabOrder]
    })),
    terminalTabs: (session.tabsByWorktree[worktreeId] ?? []).map((tab) => {
      const layout = session.terminalLayoutsByTabId[tab.id]
      return {
        id: tab.id,
        customTitle: tab.customTitle ?? null,
        panes: leafIdsInOrder(layout?.root).map((leafId) => ({
          leafId,
          ptyId: layout?.ptyIdsByLeafId?.[leafId] ?? null
        }))
      }
    })
  }
}

/** Every worktree with any tab or group, across the runtime's partitions. */
export function toOracleLayout(partitions: readonly WorkspaceLayoutPartition[]): OracleLayout {
  const layout: OracleLayout = {}
  for (const { hostId, session } of partitions) {
    const worktreeIds = new Set([
      ...Object.keys(session.tabsByWorktree ?? {}),
      ...Object.keys(session.tabGroups ?? {})
    ])
    for (const worktreeId of worktreeIds) {
      const entry = worktreeLayout(session, worktreeId)
      if (entry.terminalTabs.length > 0 || entry.groups.some((group) => group.tabOrder.length)) {
        layout[oracleWorktreeKey(hostId, worktreeId)] = entry
      }
    }
  }
  return layout
}

export function formatViolations(violations: readonly WorkspaceLayoutViolation[]): string[] {
  return violations.map((violation) => `${violation.rule}: ${violation.detail}`)
}

export { checkWorkspaceLayoutRules, type WorkspaceLayoutPartition, type WorkspaceLayoutViolation }

/** One line per difference between two layouts; `maskPtyIds` compares bound/unbound only. */
export function diffOracleLayouts(
  expected: OracleLayout,
  actual: OracleLayout,
  options: { maskPtyIds?: boolean; label?: string } = {}
): string[] {
  const label = options.label ?? 'actual'
  const differences: string[] = []
  const pty = (id: string | null): string | null =>
    options.maskPtyIds ? (id === null ? null : '<bound>') : id
  for (const key of new Set([...Object.keys(expected), ...Object.keys(actual)])) {
    const want = expected[key]
    const got = actual[key]
    if (!want || !got) {
      differences.push(`${key}: ${want ? `missing from ${label}` : `only in ${label}`}`)
      continue
    }
    const groups = (layout: OracleWorktreeLayout): string =>
      JSON.stringify(layout.groups.map((group) => [group.id, group.tabOrder]))
    if (groups(want) !== groups(got)) {
      differences.push(`${key}: groups ${groups(want)} vs ${label} ${groups(got)}`)
    }
    // Row order is not drawn anywhere; the rules check owns it (one tab order).
    const tabs = (layout: OracleWorktreeLayout): string =>
      JSON.stringify(
        layout.terminalTabs
          .toSorted((a, b) => a.id.localeCompare(b.id))
          .map((tab) => [
            tab.id,
            tab.customTitle,
            tab.panes.map((pane) => [pane.leafId, pty(pane.ptyId)])
          ])
      )
    if (tabs(want) !== tabs(got)) {
      differences.push(`${key}: terminal tabs ${tabs(want)} vs ${label} ${tabs(got)}`)
    }
  }
  return differences
}
