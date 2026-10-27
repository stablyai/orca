// Compare groups/order, all tab kinds, pane tree/bindings and custom titles; omit viewer-owned selection, focus, sizes and scroll.

import type { ExecutionHostId } from '../../../src/shared/execution-host'
import type { TerminalPaneLayoutNode } from '../../../src/shared/terminal-tab-types'
import {
  checkWorkspaceLayoutRules,
  type WorkspaceLayoutPartition,
  type WorkspaceLayoutViolation
} from '../../../src/shared/workspace-layout/workspace-layout-rules'
import { checkWorkspaceLayoutModelRules } from '../../../src/shared/workspace-layout/workspace-layout-model-rules'
import type { LiveWorkspace } from './workspace-layout-oracle-feed'

export type OraclePane = { leafId: string; ptyId: string | null }
export type OracleTab = { id: string; kind: string; entityId: string; customTitle: string | null }
export type OracleTerminalTab = { id: string; customTitle: string | null; panes: OraclePane[] }
export type OracleGroup = { id: string; tabOrder: string[] }
export type OracleWorktreeLayout = {
  groups: OracleGroup[]
  /** Every tab, all kinds, in the one tab order. */
  tabs: OracleTab[]
  /** In the one tab order. */
  terminalTabs: OracleTerminalTab[]
}
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

function worktreeLayout({ layout }: LiveWorkspace): OracleWorktreeLayout {
  return {
    groups: layout.groups.map((group) => ({ id: group.id, tabOrder: [...group.tabIds] })),
    tabs: layout.tabs.map((tab) => ({
      id: tab.id,
      kind: tab.kind,
      entityId: tab.entityId,
      customTitle: tab.customTitle
    })),
    terminalTabs: layout.tabs.flatMap((tab) =>
      tab.terminal
        ? [
            {
              id: tab.id,
              customTitle: tab.customTitle,
              panes: tab.terminal.panes.map((pane) => ({
                leafId: pane.leafId,
                ptyId: pane.ptyId ?? null
              }))
            }
          ]
        : []
    )
  }
}

/** Every workspace with any tab or group in the runtime's live layout. */
export function toOracleLayout(entries: readonly LiveWorkspace[]): OracleLayout {
  const layout: OracleLayout = {}
  for (const entry of entries) {
    const worktree = worktreeLayout(entry)
    if (worktree.tabs.length > 0 || worktree.groups.some((group) => group.tabOrder.length)) {
      layout[oracleWorktreeKey(entry.hostId, entry.layout.worktreeId)] = worktree
    }
  }
  return layout
}

export function formatViolations(violations: readonly WorkspaceLayoutViolation[]): string[] {
  return violations.map((violation) => `${violation.rule}: ${violation.detail}`)
}

export {
  checkWorkspaceLayoutModelRules,
  checkWorkspaceLayoutRules,
  type WorkspaceLayoutPartition,
  type WorkspaceLayoutViolation
}

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
    // Tab order is compared through the groups; the tab lists below are sorted.
    if (groups(want) !== groups(got)) {
      differences.push(`${key}: groups ${groups(want)} vs ${label} ${groups(got)}`)
    }
    const contents = (layout: OracleWorktreeLayout): string =>
      JSON.stringify(
        layout.tabs
          .filter((tab) => tab.kind !== 'terminal')
          .toSorted((a, b) => a.id.localeCompare(b.id))
          .map((tab) => [tab.id, tab.kind, tab.entityId, tab.customTitle])
      )
    if (contents(want) !== contents(got)) {
      differences.push(`${key}: other tabs ${contents(want)} vs ${label} ${contents(got)}`)
    }
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
