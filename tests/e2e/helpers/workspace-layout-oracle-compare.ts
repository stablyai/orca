// Compare runtime layout to each view, excluding viewer-owned selection, focus and sizes.

import { isTerminalOwnerPartition } from '../../../src/shared/workspace-layout/terminal-owner-invariants'
import type { LiveWorkspace } from './workspace-layout-oracle-feed'
import type { ClientView, DrawnLayout, DrawnTerminalSurface } from './workspace-layout-oracle-views'

type RuntimeTab = {
  worktreeId: string
  customTitle: string | null
  panes: { leafId: string; ptyId: string | null }[]
}

/** Terminal tabs by id; a tab listed in two workspaces keeps both entries. */
function indexRuntimeTabs(entries: readonly LiveWorkspace[]): Map<string, RuntimeTab[]> {
  const tabs = new Map<string, RuntimeTab[]>()
  for (const { layout } of entries) {
    for (const tab of layout.tabs) {
      if (!tab.terminal) {
        continue
      }
      const entry: RuntimeTab = {
        worktreeId: layout.worktreeId,
        customTitle: tab.customTitle,
        panes: tab.terminal.panes.map((pane) => ({
          leafId: pane.leafId,
          ptyId: pane.ptyId ?? null
        }))
      }
      tabs.set(tab.id, [...(tabs.get(tab.id) ?? []), entry])
    }
  }
  return tabs
}

function worktreeEntries(entries: readonly LiveWorkspace[], worktreeId: string): LiveWorkspace[] {
  return entries.filter((entry) => entry.layout.worktreeId === worktreeId)
}

function runtimeGroups(
  entries: readonly LiveWorkspace[],
  worktreeId: string
): Map<string, string[]> {
  const groups = new Map<string, string[]>()
  for (const { layout } of worktreeEntries(entries, worktreeId)) {
    for (const group of layout.groups) {
      groups.set(group.id, group.tabIds)
    }
  }
  return groups
}

const orderText = (order: readonly string[]): string => JSON.stringify(order)

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
  entries: readonly LiveWorkspace[],
  drawn: DrawnLayout,
  livePtyIds: ReadonlySet<string>
): string[] {
  const owned = entries.filter((entry) => isTerminalOwnerPartition(entry.hostId))
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
      } else if (orderText(order) !== orderText(strip.tabIds)) {
        differences.push(
          `group ${strip.groupId}: runtime order ${orderText(order)} but drawn ${orderText(strip.tabIds)}`
        )
      }
    }
    for (const groupId of groups.keys()) {
      if (!strips.some((strip) => strip.groupId === groupId)) {
        differences.push(`runtime group ${groupId} is not drawn (${worktreeId})`)
      }
    }
    for (const tab of worktreeEntries(owned, worktreeId).flatMap(({ layout }) => layout.tabs)) {
      if (!strips.some((strip) => strip.tabIds.includes(tab.id))) {
        differences.push(`runtime ${tab.kind} tab ${tab.id} has no drawn tab (${worktreeId})`)
      }
    }
  }
  const shownBy = new Map<string, string>()
  for (const surface of surfacesByTab(drawn)) {
    const runtime = tabs.get(surface.tabId) ?? []
    if (runtime.length === 0) {
      differences.push(`drawn terminal tab ${surface.tabId} is not in the runtime`)
    } else {
      // Compared on running terminals only; both sides may keep or drop an exited binding.
      const want = panesText(shownPanes(runtime[0]!.panes, livePtyIds))
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

export function compareClientToRuntime(
  entries: readonly LiveWorkspace[],
  view: ClientView
): string[] {
  if (view.error || !view.tabs) {
    return [`client view of ${view.worktreeId} failed: ${view.error ?? 'no snapshot'}`]
  }
  const differences: string[] = []
  const tabs = indexRuntimeTabs(entries)
  const runtimePanes = new Map<string, string | null>()
  for (const [tabId, tabEntries] of tabs) {
    for (const entry of tabEntries.filter(
      (candidate) => candidate.worktreeId === view.worktreeId
    )) {
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
  // Groups carry every tab kind, so exact group orders compare editor, browser and agent tabs too.
  const groups = runtimeGroups(entries, view.worktreeId)
  const clientGroups = new Map(
    (view.tabs.tabGroups ?? []).map((group) => [group.id, group.tabOrder])
  )
  const unmatchedRuntime = new Map([...groups].filter(([groupId]) => !clientGroups.has(groupId)))
  for (const [groupId, order] of clientGroups) {
    const want = groups.get(groupId)
    if (want) {
      if (orderText(want) !== orderText(order)) {
        differences.push(
          `group ${groupId}: runtime order ${orderText(want)} but client ${orderText(order)}`
        )
      }
      continue
    }
    // The same tabs in the same order under another id is a renamed group, not a lost one.
    const renamed = [...unmatchedRuntime].find(
      ([, runtime]) => orderText(runtime) === orderText(order)
    )
    if (renamed) {
      unmatchedRuntime.delete(renamed[0])
      differences.push(
        `group id differs: runtime ${renamed[0]}, client ${groupId} (tabs ${orderText(order)})`
      )
    } else {
      differences.push(`client group ${groupId} is not in the runtime`)
    }
  }
  for (const groupId of unmatchedRuntime.keys()) {
    differences.push(`runtime group ${groupId} is missing from the client`)
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
