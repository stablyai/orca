// A published workspace layout as the records main keys by its own ids: the workspace's groups,
// each tab's row, each terminal tab's pane tree, each pane's terminal binding, each editor file and
// browser tab. A change frame carries only the records an operation changed (design E1); splitting
// and joining keep every field, so a field added to a published type rides its record unchanged.

import { ownedEditorFileId } from '../workspace-session-pane-ownership'
import { stableJson } from './workspace-layout-load-report'
import type {
  PublishedBrowserTab,
  PublishedEditorFile,
  PublishedPane,
  PublishedTab,
  PublishedTerminal,
  PublishedWorkspaceLayout
} from './workspace-layout-published'

/** The workspace's own fields: its groups (the one tab order) and group tree. */
export type PublishedWorkspaceFields = Omit<
  PublishedWorkspaceLayout,
  'tabs' | 'editorFiles' | 'browserTabs'
>

/** A tab's row: all but its panes. A terminal tab keeps its creation fields here. */
export type PublishedTabRow = Omit<PublishedTab, 'terminal'> & {
  terminal?: Omit<PublishedTerminal, 'root' | 'panes' | 'chatLeafId'>
}

/** A pane as its tab's tree holds it: all but its terminal binding. */
export type PublishedTreePane = Omit<
  PublishedPane,
  'ptyId' | 'ptyGeneration' | 'status' | 'statusReason'
>

/** A terminal tab's pane tree, keyed by the tab's id. */
export type PublishedPaneTree = Pick<PublishedTerminal, 'root' | 'chatLeafId'> & {
  tabId: string
  /** In tree order. */
  panes: PublishedTreePane[]
}

/** A pane's terminal binding, apart from its tree so a respawn changes only this record. Its start
 *  status rides here too: a start ends in a binding or a failure, never in a tree change. */
export type PublishedPaneBinding = Pick<
  PublishedPane,
  'leafId' | 'ptyId' | 'ptyGeneration' | 'status' | 'statusReason'
>

type RecordKinds = {
  tabs: PublishedTabRow
  paneTrees: PublishedPaneTree
  bindings: PublishedPaneBinding
  editorFiles: PublishedEditorFile
  browserTabs: PublishedBrowserTab
}

type RecordKind = keyof RecordKinds

export type PublishedLayoutRecords = { workspace: PublishedWorkspaceFields } & {
  [Kind in RecordKind]: RecordKinds[Kind][]
}

/** One kind's changes: `set` adds or replaces by key; `order` is every key in order, sent when it changed. */
export type LayoutRecordChanges<T> = { set?: T[]; removed?: string[]; order?: string[] }

export type WorkspaceLayoutRecordChanges = { workspace?: PublishedWorkspaceFields } & {
  [Kind in RecordKind]?: LayoutRecordChanges<RecordKinds[Kind]>
}

export type WorkspaceLayoutRecordChange =
  | { key: string; change: 'removed' }
  /** A workspace new to the stream, or one whose records repeat a key, goes whole. */
  | { key: string; change: 'layout'; layout: PublishedWorkspaceLayout }
  | ({ key: string; change: 'records' } & WorkspaceLayoutRecordChanges)

const RECORD_KEYS: { [Kind in RecordKind]: (record: RecordKinds[Kind]) => string } = {
  tabs: (row) => row.id,
  paneTrees: (tree) => tree.tabId,
  bindings: (binding) => binding.leafId,
  // Path and owner, whatever the reader's build: a frame's order names records by these keys.
  editorFiles: (file) => ownedEditorFileId(file.filePath, '', file.runtimeEnvironmentId),
  browserTabs: (tab) => tab.id
}

export function splitPublishedLayout(layout: PublishedWorkspaceLayout): PublishedLayoutRecords {
  const { tabs, editorFiles, browserTabs, ...workspace } = layout
  const rows: PublishedTabRow[] = []
  const paneTrees: PublishedPaneTree[] = []
  const bindings: PublishedPaneBinding[] = []
  for (const tab of tabs) {
    const { terminal, ...row } = tab
    if (!terminal) {
      rows.push(row)
      continue
    }
    const { root, panes, chatLeafId, ...creation } = terminal
    rows.push({ ...row, terminal: creation })
    paneTrees.push({
      tabId: tab.id,
      root,
      ...(chatLeafId !== undefined ? { chatLeafId } : {}),
      panes: panes.map(({ ptyId, ptyGeneration, status, statusReason, ...pane }) => {
        if (
          ptyId !== undefined ||
          ptyGeneration !== undefined ||
          status !== undefined ||
          statusReason !== undefined
        ) {
          bindings.push({
            leafId: pane.leafId,
            ...(ptyId !== undefined ? { ptyId } : {}),
            ...(ptyGeneration !== undefined ? { ptyGeneration } : {}),
            ...(status !== undefined ? { status } : {}),
            ...(statusReason !== undefined ? { statusReason } : {})
          })
        }
        return pane
      })
    })
  }
  return { workspace, tabs: rows, paneTrees, bindings, editorFiles, browserTabs }
}

/** Throws when a terminal tab's row has no pane tree: the records are not one layout. */
export function joinPublishedLayout(records: PublishedLayoutRecords): PublishedWorkspaceLayout {
  const trees = new Map(records.paneTrees.map((tree) => [tree.tabId, tree]))
  const bindings = new Map(records.bindings.map((binding) => [binding.leafId, binding]))
  const tabs = records.tabs.map((row): PublishedTab => {
    const { terminal, ...rest } = row
    if (!terminal) {
      return rest
    }
    const tree = trees.get(row.id)
    if (!tree) {
      throw new Error(`layout records: terminal tab ${row.id} has no pane tree`)
    }
    const { tabId: _tabId, panes, ...treeFields } = tree
    return {
      ...rest,
      terminal: {
        ...terminal,
        ...treeFields,
        panes: panes.map((pane) => {
          const binding = bindings.get(pane.leafId)
          if (!binding) {
            return pane
          }
          const { leafId: _leafId, ...bound } = binding
          return { ...pane, ...bound }
        })
      }
    }
  })
  return {
    ...records.workspace,
    tabs,
    editorFiles: records.editorFiles,
    browserTabs: records.browserTabs
  }
}

type IndexedKind<T> = { order: string[]; byKey: Map<string, { record: T; json: string }> }

/** A layout's records with each one's JSON, so a later layout diffs record by record. */
export type IndexedLayoutRecords = {
  workspaceJson: string
  workspace: PublishedWorkspaceFields
} & {
  [Kind in RecordKind]: IndexedKind<RecordKinds[Kind]>
}

function indexKind<T>(records: T[], keyOf: (record: T) => string): IndexedKind<T> | null {
  const order: string[] = []
  const byKey = new Map<string, { record: T; json: string }>()
  for (const record of records) {
    const key = keyOf(record)
    const json = stableJson(record)
    const seen = byKey.get(key)
    // A tab in two groups repeats the same row; two records under one key cannot be keyed.
    if (seen && seen.json !== json) {
      return null
    }
    byKey.set(key, { record, json })
    order.push(key)
  }
  return { order, byKey }
}

/** Null when two different records share a key: that layout only goes whole. */
export function indexPublishedLayout(
  layout: PublishedWorkspaceLayout
): IndexedLayoutRecords | null {
  const records = splitPublishedLayout(layout)
  const tabs = indexKind(records.tabs, RECORD_KEYS.tabs)
  const paneTrees = indexKind(records.paneTrees, RECORD_KEYS.paneTrees)
  const bindings = indexKind(records.bindings, RECORD_KEYS.bindings)
  const editorFiles = indexKind(records.editorFiles, RECORD_KEYS.editorFiles)
  const browserTabs = indexKind(records.browserTabs, RECORD_KEYS.browserTabs)
  if (!tabs || !paneTrees || !bindings || !editorFiles || !browserTabs) {
    return null
  }
  return {
    workspaceJson: stableJson(records.workspace),
    workspace: records.workspace,
    tabs,
    paneTrees,
    bindings,
    editorFiles,
    browserTabs
  }
}

const sameOrder = (a: string[], b: string[]) =>
  a.length === b.length && a.every((key, index) => key === b[index])

function diffKind<T>(
  before: IndexedKind<T>,
  after: IndexedKind<T>,
  ordered: boolean
): LayoutRecordChanges<T> | undefined {
  const set: T[] = []
  for (const [key, entry] of after.byKey) {
    if (before.byKey.get(key)?.json !== entry.json) {
      set.push(entry.record)
    }
  }
  const removed = [...before.byKey.keys()].filter((key) => !after.byKey.has(key))
  const order = ordered && !sameOrder(before.order, after.order) ? after.order : undefined
  if (set.length === 0 && removed.length === 0 && !order) {
    return undefined
  }
  return {
    ...(set.length > 0 ? { set } : {}),
    ...(removed.length > 0 ? { removed } : {}),
    ...(order ? { order } : {})
  }
}

/** What changed between two published copies of one workspace; null when nothing did. */
export function diffPublishedLayouts(
  key: string,
  before: IndexedLayoutRecords | null,
  after: IndexedLayoutRecords | null,
  layout: PublishedWorkspaceLayout
): WorkspaceLayoutRecordChange | null {
  if (!before || !after) {
    return { key, change: 'layout', layout }
  }
  // Trees and bindings are placed by their tabs, so only the other kinds publish an order.
  const tabs = diffKind(before.tabs, after.tabs, true)
  const paneTrees = diffKind(before.paneTrees, after.paneTrees, false)
  const bindings = diffKind(before.bindings, after.bindings, false)
  const editorFiles = diffKind(before.editorFiles, after.editorFiles, true)
  const browserTabs = diffKind(before.browserTabs, after.browserTabs, true)
  const changes: WorkspaceLayoutRecordChanges = {
    ...(before.workspaceJson !== after.workspaceJson ? { workspace: after.workspace } : {}),
    ...(tabs ? { tabs } : {}),
    ...(paneTrees ? { paneTrees } : {}),
    ...(bindings ? { bindings } : {}),
    ...(editorFiles ? { editorFiles } : {}),
    ...(browserTabs ? { browserTabs } : {})
  }
  return Object.keys(changes).length > 0 ? { key, change: 'records', ...changes } : null
}

function applyKind<T>(
  records: T[],
  changes: LayoutRecordChanges<T> | undefined,
  keyOf: (record: T) => string,
  ordered: boolean
): T[] {
  if (!changes) {
    return records
  }
  const byKey = new Map(records.map((record) => [keyOf(record), record]))
  for (const key of changes.removed ?? []) {
    byKey.delete(key)
  }
  for (const record of changes.set ?? []) {
    byKey.set(keyOf(record), record)
  }
  if (!ordered) {
    return [...byKey.values()]
  }
  const order = changes.order ?? records.map(keyOf)
  const placed = new Set(order)
  if ([...byKey.keys()].some((key) => !placed.has(key))) {
    throw new Error('layout records: a record is missing from its order')
  }
  return order.map((key) => {
    const record = byKey.get(key)
    if (record === undefined) {
      throw new Error(`layout records: order names a missing record ${key}`)
    }
    return record
  })
}

/**
 * One workspace's change applied to what was last shown for it; undefined once removed. Throws
 * when the change does not fit `before` (a record change for a workspace never shown, a broken
 * order): the reader's copy is no longer the host's and must be fetched again.
 */
export function applyWorkspaceLayoutRecordChange(
  before: PublishedWorkspaceLayout | undefined,
  change: WorkspaceLayoutRecordChange
): PublishedWorkspaceLayout | undefined {
  if (change.change === 'removed') {
    return undefined
  }
  if (change.change === 'layout') {
    return change.layout
  }
  if (!before) {
    throw new Error(`layout records: a change for unknown workspace ${change.key}`)
  }
  const records = splitPublishedLayout(before)
  return joinPublishedLayout({
    workspace: change.workspace ?? records.workspace,
    tabs: applyKind(records.tabs, change.tabs, RECORD_KEYS.tabs, true),
    paneTrees: applyKind(records.paneTrees, change.paneTrees, RECORD_KEYS.paneTrees, false),
    bindings: applyKind(records.bindings, change.bindings, RECORD_KEYS.bindings, false),
    editorFiles: applyKind(records.editorFiles, change.editorFiles, RECORD_KEYS.editorFiles, true),
    browserTabs: applyKind(records.browserTabs, change.browserTabs, RECORD_KEYS.browserTabs, true)
  })
}
