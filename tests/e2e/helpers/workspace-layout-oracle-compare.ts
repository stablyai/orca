/**
 * View-equals-state comparisons: each returns one line per difference between the runtime's
 * layout and what a view shows. Per-viewer state (selection, focus, sizes) is never compared.
 */

import { isTerminalOwnerPartition } from '../../../src/shared/workspace-layout/terminal-owner-invariants'
import { leafIdsInOrder, type WorkspaceLayoutPartition } from './workspace-layout-oracle-model'
import type { ClientView, DrawnLayout, DrawnTerminalSurface } from './workspace-layout-oracle-views'

type RuntimeTab = {
  hostId: string
  worktreeId: string
  customTitle: string | null
  panes: { leafId: string; ptyId: string | null }[]
}

function indexRuntimeTabs(
  partitions: readonly WorkspaceLayoutPartition[]
): Map<string, RuntimeTab[]> {
  const tabs = new Map<string, RuntimeTab[]>()
  for (const { hostId, session } of partitions) {
    for (const [worktreeId, rows] of Object.entries(session.tabsByWorktree ?? {})) {
      for (const row of rows) {
        const layout = session.terminalLayoutsByTabId?.[row.id]
        const entry: RuntimeTab = {
          hostId,
          worktreeId,
          customTitle: row.customTitle ?? null,
          panes: leafIdsInOrder(layout?.root).map((leafId) => ({
            leafId,
            ptyId: layout?.ptyIdsByLeafId?.[leafId] ?? null
          }))
        }
        tabs.set(row.id, [...(tabs.get(row.id) ?? []), entry])
      }
    }
  }
  return tabs
}

function runtimeGroups(
  partitions: readonly WorkspaceLayoutPartition[],
  worktreeId: string
): Map<string, string[]> {
  const groups = new Map<string, string[]>()
  for (const { session } of partitions) {
    for (const group of session.tabGroups?.[worktreeId] ?? []) {
      groups.set(group.id, group.tabOrder)
    }
  }
  return groups
}

/** A binding to a terminal that is no longer running is a resume hint, not something shown. */
function shownPanes(
  panes: readonly { leafId: string; ptyId: string | null }[],
  livePtyIds: ReadonlySet<string>
): { leafId: string; ptyId: string | null }[] {
  return panes.map((pane) => ({
    leafId: pane.leafId,
    ptyId: pane.ptyId && livePtyIds.has(pane.ptyId) ? pane.ptyId : null
  }))
}

const panesText = (panes: readonly { leafId: string; ptyId: string | null }[]): string =>
  JSON.stringify(panes.map((pane) => [pane.leafId, pane.ptyId]))

/** One surface per tab: a tab's terminal surface element can be nested, so keep the one with panes. */
function surfacesByTab(drawn: DrawnLayout): DrawnTerminalSurface[] {
  const byTab = new Map<string, DrawnTerminalSurface>()
  for (const surface of drawn.surfaces) {
    const existing = byTab.get(surface.tabId)
    if (!existing || existing.panes.length < surface.panes.length) {
      byTab.set(surface.tabId, surface)
    }
  }
  return [...byTab.values()].filter((surface) => surface.panes.length > 0)
}

/** The window draws the layouts of the partitions it owns (local and SSH); a remote mirror is not checked. */
export function compareDrawnToRuntime(
  partitions: readonly WorkspaceLayoutPartition[],
  drawn: DrawnLayout,
  livePtyIds: ReadonlySet<string>
): string[] {
  const owned = partitions.filter((partition) => isTerminalOwnerPartition(partition.hostId))
  const differences: string[] = []
  const tabs = indexRuntimeTabs(owned)
  const drawnWorktrees = new Set(drawn.strips.map((strip) => strip.worktreeId))
  for (const worktreeId of drawnWorktrees) {
    const groups = runtimeGroups(owned, worktreeId)
    const strips = drawn.strips.filter((strip) => strip.worktreeId === worktreeId)
    for (const strip of strips) {
      const order = groups.get(strip.groupId)
      if (!order) {
        differences.push(`drawn group ${strip.groupId} is not in the runtime (${worktreeId})`)
      } else if (JSON.stringify(order) !== JSON.stringify(strip.tabIds)) {
        differences.push(
          `group ${strip.groupId}: runtime order ${JSON.stringify(order)} but drawn ${JSON.stringify(strip.tabIds)}`
        )
      }
    }
    for (const groupId of groups.keys()) {
      if (!strips.some((strip) => strip.groupId === groupId)) {
        differences.push(`runtime group ${groupId} is not drawn (${worktreeId})`)
      }
    }
    for (const [tabId, entries] of tabs) {
      const listed = strips.some((strip) => strip.tabIds.includes(tabId))
      if (entries.some((entry) => entry.worktreeId === worktreeId) && !listed) {
        differences.push(`runtime terminal tab ${tabId} has no drawn tab (${worktreeId})`)
      }
    }
  }
  const shownBy = new Map<string, string>()
  for (const surface of surfacesByTab(drawn)) {
    const entries = tabs.get(surface.tabId) ?? []
    if (entries.length === 0) {
      differences.push(`drawn terminal tab ${surface.tabId} is not in the runtime`)
    } else {
      // Compared on running terminals only; both sides may keep or drop an exited binding.
      const want = panesText(shownPanes(entries[0]!.panes, livePtyIds))
      const got = panesText(shownPanes(surface.panes, livePtyIds))
      if (want !== got) {
        differences.push(`tab ${surface.tabId}: runtime panes ${want} but drawn ${got}`)
      }
    }
    for (const pane of surface.panes) {
      const other = pane.ptyId ? shownBy.get(pane.ptyId) : undefined
      if (other) {
        differences.push(
          `terminal ${pane.ptyId} is drawn in two panes: ${other} and ${pane.leafId}`
        )
      } else if (pane.ptyId) {
        shownBy.set(pane.ptyId, pane.leafId)
      }
    }
  }
  return differences
}

/** What a paired client (session tabs) and the CLI (terminal list) are told for one worktree. */
export function compareClientToRuntime(
  partitions: readonly WorkspaceLayoutPartition[],
  view: ClientView
): string[] {
  if (view.error || !view.tabs) {
    return [`client view of ${view.worktreeId} failed: ${view.error ?? 'no snapshot'}`]
  }
  const differences: string[] = []
  const tabs = indexRuntimeTabs(partitions)
  const runtimePanes = new Map<string, string | null>()
  for (const [tabId, entries] of tabs) {
    for (const entry of entries.filter((candidate) => candidate.worktreeId === view.worktreeId)) {
      for (const pane of entry.panes) {
        runtimePanes.set(`${tabId}:${pane.leafId}`, pane.ptyId)
      }
    }
  }
  const clientPanes = new Map<string, string | null>()
  for (const tab of view.tabs.tabs) {
    if (tab.type !== 'terminal') {
      continue
    }
    const key = `${tab.parentTabId}:${tab.leafId}`
    if (clientPanes.has(key)) {
      differences.push(`client lists pane ${key} twice`)
    }
    clientPanes.set(key, tab.ptyId ?? null)
    const customTitle = tabs.get(tab.parentTabId)?.[0]?.customTitle
    if (customTitle && tab.title !== customTitle) {
      differences.push(
        `client titles ${key} "${tab.title}" but the runtime named it "${customTitle}"`
      )
    }
  }
  for (const [key, ptyId] of runtimePanes) {
    if (!clientPanes.has(key)) {
      differences.push(`runtime pane ${key} is missing from the client`)
    } else if ((clientPanes.get(key) ?? null) !== ptyId) {
      differences.push(`pane ${key}: runtime shows ${ptyId}, client ${clientPanes.get(key)}`)
    }
  }
  for (const key of clientPanes.keys()) {
    if (!runtimePanes.has(key)) {
      differences.push(`client pane ${key} is not in the runtime`)
    }
  }
  const groups = runtimeGroups(partitions, view.worktreeId)
  for (const group of view.tabs.tabGroups ?? []) {
    const order = groups.get(group.id)
    if (order && JSON.stringify(order) !== JSON.stringify(group.tabOrder)) {
      differences.push(
        `group ${group.id}: runtime order ${JSON.stringify(order)} but client ${JSON.stringify(group.tabOrder)}`
      )
    }
  }
  for (const terminal of view.terminals) {
    const key = `${terminal.tabId}:${terminal.leafId}`
    if (terminal.orphaned) {
      differences.push(`terminal ${terminal.ptyId} is running with no pane (last at ${key})`)
    } else if (!runtimePanes.has(key)) {
      differences.push(`CLI lists terminal ${terminal.ptyId} at ${key}, which the runtime lacks`)
    } else if (terminal.ptyId && runtimePanes.get(key) !== terminal.ptyId) {
      differences.push(`CLI says ${key} runs ${terminal.ptyId}, runtime ${runtimePanes.get(key)}`)
    }
  }
  return differences
}
