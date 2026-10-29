import { SessionUnitIndex } from '../session-unit-index'
import { SessionUnitReader, type SessionUnitView } from '../session-unit-reader'
import { SESSION_MAP_FIELDS, isSessionMapField, type SessionMapField } from '../session-change-set'
// Load one session partition after Store pane-identity normalization. Reapply fixed precedence on every load because older builds may rewrite the documents; do not merge disagreements.

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
import { omitStoredFields } from './stored-record-fields'
import {
  applyLegacySurfaceTombstones,
  loadLeaves,
  unbindDuplicateTerminals
} from './workspace-layout-load-bindings'
import { diffStoredSession } from './workspace-layout-load-report'
import type {
  LoadedWorkspaceLayout,
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

const WORKSPACE_SOURCE_FIELDS = [
  'tabsByWorktree',
  'unifiedTabs',
  'tabGroups',
  'tabGroupLayouts',
  'openFilesByWorktree',
  'browserTabsByWorktree'
] as const

function workspaceKeys(session: WorkspaceSessionState): string[] {
  return [...new Set(WORKSPACE_SOURCE_FIELDS.flatMap((field) => Object.keys(session[field] ?? {})))]
}

/** Keep a terminal row in the workspace whose tab bar/group names it, falling back to its first occurrence. */
function resolveTerminalHomes(
  reader: SessionUnitView,
  owners: readonly string[]
): Map<string, string> {
  const homes = new Map<string, string>()
  const namedByTabBar = (key: string, tabId: string): boolean =>
    (reader.unit('unifiedTabs', key).value ?? []).some(
      (entry) => entry.contentType === 'terminal' && entry.entityId === tabId
    ) || (reader.unit('tabGroups', key).value ?? []).some((group) => group.tabOrder.includes(tabId))
  for (const key of owners) {
    const rows = reader.unit('tabsByWorktree', key).value ?? []
    for (const row of rows) {
      const home = homes.get(row.id)
      if (home === undefined || (!namedByTabBar(home, row.id) && namedByTabBar(key, row.id))) {
        homes.set(row.id, key)
      }
    }
  }
  return homes
}

function loadRecords(
  reader: SessionUnitView,
  selected: ReadonlyMap<SessionMapField, ReadonlySet<string>>
): WorkspaceLayoutRecords {
  return {
    ...(reader.hasField('defaultTerminalTabsAppliedByWorktreeId')
      ? {
          defaultTabsAppliedByWorkspace: reader.map(
            'defaultTerminalTabsAppliedByWorktreeId',
            selected.get('defaultTerminalTabsAppliedByWorktreeId') ?? []
          )
        }
      : {}),
    ...(reader.hasField('clientHostedBrowserPagesByWorktree')
      ? {
          clientHostedBrowserPagesByWorkspace: reader.map(
            'clientHostedBrowserPagesByWorktree',
            selected.get('clientHostedBrowserPagesByWorktree') ?? []
          )
        }
      : {}),
    ...(reader.hasField('closedTerminalPanesByPaneKey')
      ? {
          closedTerminalPanesByPaneKey: reader.map(
            'closedTerminalPanesByPaneKey',
            selected.get('closedTerminalPanesByPaneKey') ?? []
          )
        }
      : {})
  }
}

function loadLegacy(
  reader: SessionUnitView,
  owners: readonly string[],
  selected: ReadonlyMap<SessionMapField, ReadonlySet<string>>
): LegacyLayoutPersistence {
  return {
    terminalRowOwners: Object.fromEntries(
      owners
        .filter((key) => reader.unit('tabsByWorktree', key).present)
        .map((key) => [key, true as const])
    ),
    ...(reader.hasField('terminalTopologyRevisionByRepoId')
      ? {
          topologyRevisionByRepoId: reader.map(
            'terminalTopologyRevisionByRepoId',
            selected.get('terminalTopologyRevisionByRepoId') ?? []
          )
        }
      : {})
  }
}

function readBesideFields<F extends keyof WorkspaceSessionState>(
  reader: SessionUnitView,
  fields: readonly F[],
  selected: ReadonlyMap<SessionMapField, ReadonlySet<string>>
): Pick<WorkspaceSessionState, F> {
  const result = {}
  for (const field of fields) {
    if (isSessionMapField(field)) {
      if (reader.hasField(field)) {
        Object.assign(result, { [field]: reader.map(field, selected.get(field) ?? []) })
      }
    } else {
      const value = reader.field(field)
      if (value.present) {
        Object.assign(result, { [field]: value.value })
      }
    }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: every selected field has the same value type as the captured root.
  return result as Pick<WorkspaceSessionState, F>
}

/** A closed tab's record goes to the workspace its worktree id names, else it is carried. */
function placeClosedTabs(
  records: WorkspaceSessionState['closedTerminalTabTombstonesByTabId'],
  layout: WorkspaceLayoutModel,
  carried: CarriedSessionFields
): void {
  const byWorktree = new Map<string, WorkspaceLayout>()
  for (const workspace of Object.values(layout.workspaces)) {
    byWorktree.set(workspace.worktreeId, byWorktree.get(workspace.worktreeId) ?? workspace)
  }
  for (const [tabId, record] of Object.entries(records ?? {})) {
    const workspace = byWorktree.get(record.worktreeId)
    if (workspace === undefined) {
      carried.unplacedClosedTabs[tabId] = record
    } else {
      const entry = omitStoredFields(record, ['worktreeId'])
      workspace.closedTerminalTabs = { ...workspace.closedTerminalTabs, [tabId]: entry }
    }
  }
}

/** A selection naming a dropped row follows its tab-bar twin, as the window's startup does. */
function followSubsumedTabSelections(
  view: DesktopLayoutView,
  canonicalTabIdBySubsumedTabId: ReadonlyMap<string, string>
): void {
  const follow = (tabId: string) => canonicalTabIdBySubsumedTabId.get(tabId) ?? tabId
  if (view.activeTabId) {
    view.activeTabId = follow(view.activeTabId)
  }
  if (view.activeTabIdByWorktree) {
    view.activeTabIdByWorktree = Object.fromEntries(
      Object.entries(view.activeTabIdByWorktree).map(([key, tabId]) => [
        key,
        tabId ? follow(tabId) : tabId
      ])
    )
  }
}

/** Report every stored-to-next-save field difference after resolving fixed precedence. */
export function loadWorkspaceLayout(
  hostId: ExecutionHostId,
  stored: WorkspaceSessionState,
  context: WorkspaceLayoutLoadContext
): WorkspaceLayoutLoadResult {
  const loaded = loadWorkspaceLayoutWithoutReport(hostId, stored, context)
  return { ...loaded, changes: diffStoredSession(stored, saveWorkspaceLayout(loaded)) }
}

/** The same load without the save and diff, for a reader that never writes the result back. */
export function loadWorkspaceLayoutWithoutReport(
  hostId: ExecutionHostId,
  stored: WorkspaceSessionState,
  context: WorkspaceLayoutLoadContext
): LoadedWorkspaceLayout {
  const reader = new SessionUnitReader(stored, new SessionUnitIndex(stored))
  const selected = new Map(
    SESSION_MAP_FIELDS.map((field) => [field, new Set(reader.index.keys(field))])
  )
  return loadWorkspaceLayoutUnits(hostId, reader, workspaceKeys(stored), selected, context)
}

/** Selection schedules kernels; every kernel reads actual prior/candidate values. */
export function loadWorkspaceLayoutUnits(
  hostId: ExecutionHostId,
  reader: SessionUnitView,
  owners: readonly string[],
  selected: ReadonlyMap<SessionMapField, ReadonlySet<string>>,
  context: WorkspaceLayoutLoadContext
): LoadedWorkspaceLayout {
  owners = owners.filter((key) =>
    WORKSPACE_SOURCE_FIELDS.some((field) => reader.unit(field, key).present)
  )
  const desktopView: DesktopLayoutView = {
    ...readBesideFields(reader, VIEW_SESSION_FIELDS, selected),
    activeRepoId: reader.field('activeRepoId').value ?? null,
    activeWorktreeId: reader.field('activeWorktreeId').value ?? null,
    activeTabId: reader.field('activeTabId').value ?? null,
    groups: {},
    lastFocusedAt: {},
    panes: {},
    editorDrafts: {}
  }
  const facts: LayoutContentFacts = {
    ...readBesideFields(reader, FACT_SESSION_FIELDS, selected),
    tabLabels: {},
    terminalRows: {},
    scrollback: {},
    browserTabs: {}
  }
  let layout: WorkspaceLayoutModel = {
    hostId,
    workspaces: {},
    records: loadRecords(reader, selected),
    legacy: loadLegacy(reader, owners, selected)
  }
  const terminalHomes = resolveTerminalHomes(reader, owners)
  const layouts = new Map<string, TerminalLayoutSnapshot>()
  const canonicalTabIdBySubsumedTabId = new Map<string, string>()
  for (const key of owners) {
    layout.workspaces[key] = loadWorkspace({
      session: reader,
      hostId,
      key,
      terminalHomes,
      context,
      view: desktopView,
      facts,
      layouts,
      canonicalTabIdBySubsumedTabId
    })
  }
  followSubsumedTabSelections(desktopView, canonicalTabIdBySubsumedTabId)
  const carried: CarriedSessionFields = {
    ...readBesideFields(reader, CARRIED_SESSION_FIELDS, selected),
    unownedTerminalLayouts: Object.fromEntries(
      Object.entries(
        reader.map('terminalLayoutsByTabId', selected.get('terminalLayoutsByTabId') ?? [])
      ).filter(([tabId]) => !terminalHomes.has(tabId))
    ),
    unplacedSleepingRecords: {},
    unplacedIncarnations: {},
    unplacedClosedTabs: {}
  }
  placeClosedTabs(
    reader.map(
      'closedTerminalTabTombstonesByTabId',
      selected.get('closedTerminalTabTombstonesByTabId') ?? []
    ),
    layout,
    carried
  )
  loadLeaves(
    layout,
    { session: reader, layouts, selected },
    { view: desktopView, facts, carried },
    context
  )
  unbindDuplicateTerminals(layout)
  layout = applyLegacySurfaceTombstones(
    layout,
    reader,
    carried,
    selected.get('terminalSurfaceTombstonesByPaneKey')
  )
  return { layout, desktopView, facts, carried }
}
