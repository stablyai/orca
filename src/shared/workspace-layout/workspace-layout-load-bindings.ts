// Stored pane data uses leaf IDs within tabs and full pane keys in records; remint repeated IDs before loading into the partition-wide leaf map.

import { isPaneSleepRecord, type SleepingAgentSessionRecord } from '../agent-session-resume'
import type { TerminalLayoutSnapshot } from '../terminal-tab-types'
import type { WorkspaceSessionState } from '../workspace-session-state-types'
import { omitStoredFields } from './stored-record-fields'
import type {
  CarriedSessionFields,
  DesktopLayoutView,
  LayoutContentFacts
} from './workspace-layout-beside'
import { isSameTerminal } from './terminal-owner-invariants'
import { collectLayoutLeafIdsInOrder } from './terminal-pane-tree'
import { updateLegacyPersistence } from './workspace-layout-legacy-persistence'
import type { WorkspaceLayoutLoadContext } from './workspace-layout-load-types'
import {
  paneKeyOf,
  tabsInOrder,
  type LayoutLeaf,
  type LayoutTerminalPanes,
  type WorkspaceLayoutModel
} from './workspace-layout-model'
import { retireExitedSurface } from './workspace-layout-removal'

function terminalTabsInOrder(model: WorkspaceLayoutModel) {
  return Object.values(model.workspaces).flatMap((workspace) =>
    tabsInOrder(workspace).flatMap((tab) => (tab.kind === 'terminal' ? [{ workspace, tab }] : []))
  )
}

type Remint = {
  tabId: string
  seen: Set<string>
  /** A stored id → its first pane's id. */
  renamed: Map<string, string>
  /** Leaves walked in this tab so far: a repeated id's position, for its new id's seed. */
  position: number
  context: WorkspaceLayoutLoadContext
}

function remintRepeatedLeaves(
  root: LayoutTerminalPanes['root'],
  remint: Remint
): LayoutTerminalPanes['root'] {
  if (!root) {
    return root
  }
  if (root.type === 'split') {
    const first = remintRepeatedLeaves(root.first, remint)!
    return { ...root, first, second: remintRepeatedLeaves(root.second, remint)! }
  }
  const { seen, renamed, context } = remint
  const position = remint.position++
  const leafId = seen.has(root.leafId)
    ? context.mintLeafId(`leaf:${remint.tabId}:${position}`)
    : root.leafId
  seen.add(leafId)
  if (!renamed.has(root.leafId)) {
    renamed.set(root.leafId, leafId)
  }
  return leafId === root.leafId ? root : { type: 'leaf', leafId }
}

type PaneRecords = {
  sleeping: Record<string, SleepingAgentSessionRecord>
  incarnations: Record<string, string>
}

function loadLeaf(
  stored: TerminalLayoutSnapshot,
  leafId: string,
  paneKey: string,
  records: PaneRecords
) {
  const saved = records.sleeping[paneKey]
  const record = saved && omitStoredFields(saved, ['paneKey', 'tabId', 'worktreeId'])
  const leaf: LayoutLeaf = {
    ...(stored.ptyIdsByLeafId?.[leafId] !== undefined
      ? { ptyId: stored.ptyIdsByLeafId[leafId] }
      : {}),
    ...(records.incarnations[paneKey] !== undefined
      ? { incarnationId: records.incarnations[paneKey] }
      : {}),
    ...(stored.titlesByLeafId?.[leafId] !== undefined
      ? { title: stored.titlesByLeafId[leafId] }
      : {}),
    ...(stored.lastGridsByLeafId?.[leafId] !== undefined
      ? { lastGrid: stored.lastGridsByLeafId[leafId] }
      : {}),
    ...(record && (isPaneSleepRecord(record) ? { sleeping: record } : { resume: record }))
  }
  delete records.sleeping[paneKey]
  delete records.incarnations[paneKey]
  return leaf
}

/** The first pane in tab order keeps a repeated leaf ID; later panes receive fresh IDs and their own records. Carry records naming no pane unchanged. */
export function loadLeaves(
  model: WorkspaceLayoutModel,
  stored: { session: WorkspaceSessionState; layouts: ReadonlyMap<string, TerminalLayoutSnapshot> },
  beside: { view: DesktopLayoutView; facts: LayoutContentFacts; carried: CarriedSessionFields },
  context: WorkspaceLayoutLoadContext
): void {
  const records: PaneRecords = {
    sleeping: { ...stored.session.sleepingAgentSessionsByPaneKey },
    incarnations: { ...stored.session.terminalPtyIncarnationsByPaneKey }
  }
  const seen = new Set<string>()
  for (const { workspace, tab } of terminalTabsInOrder(model)) {
    const layout = stored.layouts.get(tab.entityId)!
    const renamed = new Map<string, string>()
    // Loaded copies can be edited without mutating stored data.
    tab.panes.root = remintRepeatedLeaves(tab.panes.root, {
      tabId: tab.entityId,
      seen,
      renamed,
      position: 0,
      context
    })
    const modelId = (leafId: string) => renamed.get(leafId) ?? leafId
    if (tab.panes.chatLeafId !== undefined) {
      tab.panes.chatLeafId = modelId(tab.panes.chatLeafId)
    }
    beside.view.panes[tab.entityId] = {
      activeLeafId: layout.activeLeafId === null ? null : modelId(layout.activeLeafId),
      expandedLeafId: layout.expandedLeafId === null ? null : modelId(layout.expandedLeafId)
    }
    for (const [storedId, leafId] of renamed) {
      const leaf = loadLeaf(layout, storedId, paneKeyOf(tab.entityId, storedId), records)
      if (leafId !== storedId) {
        // A reminted pane cannot retain a terminal started for its previous ID.
        delete leaf.ptyId
      } else {
        const generation = context.ptyGenerationOf?.(leafId)
        if (generation !== undefined) {
          leaf.ptyGeneration = generation
        }
      }
      if (Object.keys(leaf).length > 0) {
        workspace.leaves = { ...workspace.leaves, [leafId]: leaf }
      }
      const scrollback = {
        ...(layout.buffersByLeafId?.[storedId] !== undefined
          ? { buffer: layout.buffersByLeafId[storedId] }
          : {}),
        ...(layout.scrollbackRefsByLeafId?.[storedId] !== undefined
          ? { scrollbackRef: layout.scrollbackRefsByLeafId[storedId] }
          : {})
      }
      if (Object.keys(scrollback).length > 0) {
        beside.facts.scrollback[leafId] = scrollback
      }
    }
  }
  beside.carried.unplacedSleepingRecords = records.sleeping
  beside.carried.unplacedIncarnations = records.incarnations
}

export function unbindDuplicateTerminals(model: WorkspaceLayoutModel): void {
  const owners: { ptyId: string; incarnationId?: string }[] = []
  for (const { workspace, tab } of terminalTabsInOrder(model)) {
    for (const leafId of collectLayoutLeafIdsInOrder(tab.panes.root)) {
      const leaf = workspace.leaves?.[leafId]
      if (leaf?.ptyId === undefined) {
        continue
      }
      const binding = { ptyId: leaf.ptyId, incarnationId: leaf.incarnationId }
      if (owners.some((candidate) => isSameTerminal(candidate, binding))) {
        delete leaf.ptyId
      } else {
        owners.push(binding)
      }
    }
  }
}

/** Apply legacy surface tombstones as retirements, then stop writing them. */
export function applyLegacySurfaceTombstones(
  model: WorkspaceLayoutModel,
  session: WorkspaceSessionState,
  carried: CarriedSessionFields
): WorkspaceLayoutModel {
  let next = model
  const tombstones = Object.values(session.terminalSurfaceTombstonesByPaneKey ?? {})
  for (const tombstone of tombstones) {
    const retired = retireExitedSurface(next, {
      ...tombstone,
      terminalTabId: tombstone.parentTabId
    })
    if (retired === next) {
      // Its pane is already gone: only a record naming it remains.
      delete carried.unplacedIncarnations[paneKeyOf(tombstone.parentTabId, tombstone.leafId)]
    }
    next = retired ?? next
  }
  // Clearing a tombstone must not drop the authority it gave older builds' save merge.
  return updateLegacyPersistence(
    model,
    next,
    tombstones.map((tombstone) => tombstone.worktreeId)
  )
}
