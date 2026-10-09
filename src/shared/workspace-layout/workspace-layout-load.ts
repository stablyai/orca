// Loader: one stored session partition (as the Store loads it, after its pane identity
// normalization) into the layout model and what is kept beside it. Runs on every load because an
// older build can write the same documents between upgrades. Stored data that disagrees with
// itself is resolved by fixed precedence; nothing is merged.

import type { ExecutionHostId } from '../execution-host'
import type { TerminalLayoutSnapshot } from '../terminal-tab-types'
import type { WorkspaceSessionState } from '../workspace-session-state-types'
import {
  CARRIED_SESSION_FIELDS,
  FACT_SESSION_FIELDS,
  VIEW_SESSION_FIELDS,
  type CarriedSessionFields,
  type DesktopLayoutView,
  type LayoutContentFacts
} from './workspace-layout-beside'
import { omitStoredFields, pickStoredFields } from './stored-record-fields'
import {
  applyLegacySurfaceTombstones,
  loadLeaves,
  unbindDuplicateTerminals
} from './workspace-layout-load-bindings'
import { diffStoredSession } from './workspace-layout-load-report'
import type {
  WorkspaceLayoutLoadContext,
  WorkspaceLayoutLoadResult
} from './workspace-layout-load-types'
import { saveWorkspaceLayout } from './workspace-layout-save'
import { loadWorkspace } from './workspace-layout-load-workspace'
import type {
  LegacyLayoutPersistence,
  WorkspaceLayout,
  WorkspaceLayoutModel,
  WorkspaceLayoutRecords
} from './workspace-layout-model'

function workspaceKeys(session: WorkspaceSessionState): string[] {
  return [
    ...new Set([
      ...Object.keys(session.tabsByWorktree ?? {}),
      ...Object.keys(session.unifiedTabs ?? {}),
      ...Object.keys(session.tabGroups ?? {}),
      ...Object.keys(session.tabGroupLayouts ?? {}),
      ...Object.keys(session.openFilesByWorktree ?? {}),
      ...Object.keys(session.browserTabsByWorktree ?? {})
    ])
  ]
}

/**
 * A terminal row stored in two workspaces is kept where the tab bar or a group also names it,
 * else in the first; the other copies are dropped.
 */
function resolveTerminalHomes(session: WorkspaceSessionState): Map<string, string> {
  const homes = new Map<string, string>()
  const namedByTabBar = (key: string, tabId: string): boolean =>
    (session.unifiedTabs?.[key] ?? []).some(
      (entry) => entry.contentType === 'terminal' && entry.entityId === tabId
    ) || (session.tabGroups?.[key] ?? []).some((group) => group.tabOrder.includes(tabId))
  for (const [key, rows] of Object.entries(session.tabsByWorktree ?? {})) {
    for (const row of rows) {
      const home = homes.get(row.id)
      if (home === undefined || (!namedByTabBar(home, row.id) && namedByTabBar(key, row.id))) {
        homes.set(row.id, key)
      }
    }
  }
  return homes
}

function loadRecords(session: WorkspaceSessionState): WorkspaceLayoutRecords {
  return {
    ...(session.defaultTerminalTabsAppliedByWorktreeId
      ? { defaultTabsAppliedByWorkspace: session.defaultTerminalTabsAppliedByWorktreeId }
      : {}),
    ...(session.clientHostedBrowserPagesByWorktree
      ? { clientHostedBrowserPagesByWorkspace: session.clientHostedBrowserPagesByWorktree }
      : {})
  }
}

function loadLegacy(session: WorkspaceSessionState): LegacyLayoutPersistence {
  return {
    terminalRowOwners: Object.fromEntries(
      Object.keys(session.tabsByWorktree ?? {}).map((key) => [key, true as const])
    ),
    ...(session.terminalTopologyRevisionByRepoId
      ? { topologyRevisionByRepoId: session.terminalTopologyRevisionByRepoId }
      : {})
  }
}

/** A closed tab's record goes to the workspace its worktree id names, else it is carried. */
function placeClosedTabs(
  session: WorkspaceSessionState,
  layout: WorkspaceLayoutModel,
  carried: CarriedSessionFields
): void {
  const byWorktree = new Map<string, WorkspaceLayout>()
  for (const workspace of Object.values(layout.workspaces)) {
    byWorktree.set(workspace.worktreeId, byWorktree.get(workspace.worktreeId) ?? workspace)
  }
  for (const [tabId, record] of Object.entries(session.closedTerminalTabTombstonesByTabId ?? {})) {
    const workspace = byWorktree.get(record.worktreeId)
    if (workspace === undefined) {
      carried.unplacedClosedTabs[tabId] = record
    } else {
      const entry = omitStoredFields(record, ['worktreeId'])
      workspace.closedTerminalTabs = { ...workspace.closedTerminalTabs, [tabId]: entry }
    }
  }
}

/**
 * Loads by fixed precedence only. What the next save would write differently from `stored` is
 * reported as one field-by-field diff, so every changed value is in it by construction.
 */
export function loadWorkspaceLayout(
  hostId: ExecutionHostId,
  stored: WorkspaceSessionState,
  context: WorkspaceLayoutLoadContext
): WorkspaceLayoutLoadResult {
  // The Loader edits its own copy; the Store's object stays untouched.
  const session = structuredClone(stored)
  const desktopView: DesktopLayoutView = {
    ...pickStoredFields(session, VIEW_SESSION_FIELDS),
    activeRepoId: session.activeRepoId,
    activeWorktreeId: session.activeWorktreeId,
    activeTabId: session.activeTabId,
    groups: {},
    lastFocusedAt: {},
    panes: {},
    editorDrafts: {}
  }
  const facts: LayoutContentFacts = {
    ...pickStoredFields(session, FACT_SESSION_FIELDS),
    tabLabels: {},
    terminalRows: {},
    scrollback: {},
    browserTabs: {}
  }
  let layout: WorkspaceLayoutModel = {
    hostId,
    workspaces: {},
    records: loadRecords(session),
    legacy: loadLegacy(session)
  }
  const terminalHomes = resolveTerminalHomes(session)
  const layouts = new Map<string, TerminalLayoutSnapshot>()
  for (const key of workspaceKeys(session)) {
    layout.workspaces[key] = loadWorkspace({
      session,
      hostId,
      key,
      terminalHomes,
      context,
      view: desktopView,
      facts,
      layouts
    })
  }
  const carried: CarriedSessionFields = {
    ...pickStoredFields(session, CARRIED_SESSION_FIELDS),
    unownedTerminalLayouts: Object.fromEntries(
      Object.entries(session.terminalLayoutsByTabId ?? {}).filter(
        ([tabId]) => !terminalHomes.has(tabId)
      )
    ),
    unplacedSleepingRecords: {},
    unplacedIncarnations: {},
    unplacedClosedTabs: {}
  }
  placeClosedTabs(session, layout, carried)
  loadLeaves(layout, { session, layouts }, { view: desktopView, facts, carried }, context)
  unbindDuplicateTerminals(layout)
  layout = applyLegacySurfaceTombstones(layout, session, carried)
  const loaded = { layout, desktopView, facts, carried }
  return { ...loaded, changes: diffStoredSession(stored, saveWorkspaceLayout(loaded)) }
}
