// Every on-disk field is written from exactly one model or side-data field, and on-disk fields
// that are copies of one fact are written from the same one. The tables
// (workspace-layout-disk-fields.ts) are typed over the disk record types and every model and
// side-data field; this test checks each claim by mutating every source and saving.

import { describe, expect, it } from 'vitest'
import { LOCAL_EXECUTION_HOST_ID } from '../execution-host'
import {
  DISK_TABLES,
  type DiskFieldWritten,
  type LayoutSource,
  type UnwrittenLayoutSource
} from './workspace-layout-disk-fields'
import { loadWorkspaceLayout } from './workspace-layout-load'
import { diskRecords, stableJson } from './workspace-layout-load-report'
import type { LoadedWorkspaceLayout } from './workspace-layout-load-types'
import type { LayoutSleepingRecord } from './workspace-layout-model'
import { localDesktopSession } from './workspace-layout-profile.test-fixture'
import { saveWorkspaceLayout } from './workspace-layout-save'
import { addWorkspace, GIT_KEY, leaf } from './workspace-layout-session.test-fixture'
import type { WorkspaceSessionState } from '../workspace-session-state-types'

// A model or side-data field no disk field is written from fails here.
const everySourceIsWritten: [UnwrittenLayoutSource] extends [never] ? true : UnwrittenLayoutSource =
  true

/** On-disk fields that hold one fact; each group must be written from the same source. */
const COPIES = [
  ['row.ptyId', 'layout.ptyIdsByLeafId'],
  ['row.id', 'terminalEntry.entityId'],
  ['row.title', 'terminalEntry.label'],
  ['row.customTitle', 'terminalEntry.customLabel'],
  ['row.generatedTitle', 'terminalEntry.generatedLabel'],
  ...['createdAt', 'color', 'aiVaultTitle', 'quickCommandLabel', 'isPinned', 'viewMode'].map(
    (field) => [`row.${field}`, `terminalEntry.${field}`]
  ),
  ['row.sortOrder', 'terminalEntry.sortOrder', 'entry.sortOrder', 'group.tabOrder'],
  [
    'row.worktreeId',
    'terminalEntry.worktreeId',
    'entry.worktreeId',
    'group.worktreeId',
    'file.worktreeId',
    'browser.worktreeId',
    'sleeping.worktreeId',
    'closedTab.worktreeId'
  ],
  ['sleeping.paneKey', 'sleeping.tabId'],
  ['terminalEntry.executionHostId', 'entry.executionHostId'],
  ['entry.isPreview', 'file.isPreview'],
  ['terminalEntry.groupId', 'entry.groupId', 'group.id']
]

/** Ids other records reference; mutating one would break the references, not test a source. */
const IDENTITY_SOURCES = new Set<LayoutSource>([
  'tab.id',
  'tab.entityId',
  'tab.kind',
  'group.id',
  'file.filePath',
  'browserTab.id',
  'leaf.$key'
])

const WRITTEN_BY_FIELD = new Map<string, DiskFieldWritten>(
  Object.entries(DISK_TABLES).flatMap(([table, fields]) =>
    Object.entries(fields).map(([field, written]): [string, DiskFieldWritten] => [
      `${table}.${field}`,
      written
    ])
  )
)

// Rows and tab-bar entries are written in the one tab order; groups in the workspace's group list.
const TAB_LIST_ORDER: DiskFieldWritten = {
  from: 'group.tabOrder',
  via: ['group.id', 'legacy.terminalRowOwners']
}
const GROUP_LIST_ORDER: DiskFieldWritten = { from: 'group.id' }

const writtenOf = (field: string): DiskFieldWritten =>
  field === 'group.$order'
    ? GROUP_LIST_ORDER
    : field.endsWith('.$order')
      ? TAB_LIST_ORDER
      : WRITTEN_BY_FIELD.get(field)!

const sourcesOf = (written: DiskFieldWritten): LayoutSource[] =>
  typeof written === 'string' ? [] : [written.from, ...(written.via ?? [])]

/** The richest session the fixtures build, with every optional source populated. */
function richLoaded(): LoadedWorkspaceLayout {
  const session = localDesktopSession()
  // A workspace with no terminal that still keeps its (empty) row list.
  addWorkspace(session, 'repo-2::/Users/dev/empty', [
    { id: 'group-empty', tabs: [{ id: 'browser-2', kind: 'browser' }] }
  ])
  session.tabsByWorktree['repo-2::/Users/dev/empty'] = []
  let next = 0
  const loaded = loadWorkspaceLayout(LOCAL_EXECUTION_HOST_ID, session, {
    mintId: () => `minted-${++next}`,
    mintLeafId: () => leaf(9)
  })
  return populate(loaded)
}

/** Sets `source` on the first holder `pick` accepts. */
function fill(
  loaded: LoadedWorkspaceLayout,
  source: LayoutSource,
  value: unknown,
  pick: (holder: Holder) => boolean = () => true
): void {
  const [prefix, field] = splitSource(source)
  holdersOf(loaded, prefix).find(pick)![field] = value
}

function populate(loaded: LoadedWorkspaceLayout): LoadedWorkspaceLayout {
  const terminal = (holder: Holder) => holder.kind === 'terminal'
  fill(loaded, 'tab.aiVaultTitle', { agent: 'codex', sessionId: 's', title: 't' }, terminal)
  fill(loaded, 'tab.quickCommandLabel', 'build', terminal)
  fill(loaded, 'tab.isPreview', true, (holder) => holder.kind === 'editor')
  fill(loaded, 'tab.terminal.forceHostRuntime', true)
  fill(loaded, 'tab.terminal.agentLaunchPane', { leafId: leaf(1) })
  fill(loaded, 'file.externalSshTargetId', 'box')
  fill(loaded, 'file.runtimeEnvironmentId', 'env')
  fill(loaded, 'file.readOnly', true)
  fill(loaded, 'file.liveTail', true)
  // A focused and an expanded pane that is not the first, so a fallback is visible.
  fill(loaded, 'viewPane.activeLeafId', leaf(2), (holder) => holder.activeLeafId === leaf(1))
  fill(loaded, 'viewPane.expandedLeafId', leaf(2), (holder) => holder.activeLeafId === leaf(2))
  fill(loaded, 'scrollback.buffer', 'buffer')
  fill(loaded, 'browserTab.sessionProfileId', 'profile-1')
  fill(loaded, 'browserTab.sessionPartition', 'persist:p')
  fill(loaded, 'browserTab.pageIds', ['page-1', 'page-2'])
  fill(loaded, 'browserLive.faviconUrl', 'https://example.com/icon')
  fill(loaded, 'browserLive.loadError', { code: -1, description: 'failed', validatedUrl: 'u' })
  fill(loaded, 'browserLive.docLocation', { kind: 'file', path: '/doc.md' })
  fill(loaded, 'view.activeWorkspaceExecutionHostId', LOCAL_EXECUTION_HOST_ID)
  fill(loaded, 'carried.remoteSessionIdsByTabId', { 'tab-shell': 'remote-1' })
  fill(loaded, 'records.clientHostedBrowserPagesByWorkspace', { 'browser-1': [{ id: 'page-1' }] })
  // Tab fields on both kinds, since terminal and content tabs are written to different tables.
  const content = (holder: Holder) => holder.kind === 'browser'
  fill(loaded, 'tab.aiVaultTitle', { agent: 'codex', sessionId: 's', title: 't' }, content)
  fill(loaded, 'tab.quickCommandLabel', 'open', content)
  fill(loaded, 'tab.isPinned', true, content)
  fill(loaded, 'tab.generatedTitle', 'Docs page', content)
  fill(loaded, 'tab.viewMode', 'terminal', content)
  fill(loaded, 'tab.isPreview', true, terminal)
  fill(loaded, 'tab.agentSessionAgent', 'claude', terminal)
  fill(loaded, 'view.lastFocusedAt', { [GIT_KEY]: { 'tab-agent': 1, 'browser-1': 2 } })
  fill(loaded, 'view.markdownFrontmatterVisible', { '/doc.md': true })
  fill(loaded, 'carried.activeConnectionIdsAtShutdown', ['target-1', 'target-2'])
  fill(loaded, 'carried.browserUrlHistory', [{ url: 'a' }, { url: 'b' }])
  fill(loaded, 'carried.workspaceDocHistory', [{ path: 'a' }, { path: 'b' }])
  fill(loaded, 'carried.clientHostedBrowserCloseIntentsByEnvironment', {
    env: ['page-1', 'page-2']
  })
  const sleeping = (field: keyof LayoutSleepingRecord, value: unknown) =>
    fill(loaded, `leaf.sleeping.${field}` as const, value)
  sleeping('terminalTitle', 'claude')
  sleeping('lastAssistantMessage', 'done')
  sleeping('interrupted', true)
  sleeping('mainAgent', { state: 'done' })
  sleeping('connectionId', 'conn-1')
  sleeping('launchConfig', { agentArgs: '', agentEnv: {} })
  sleeping('restoreOnTabOpenOnly', true)
  fill(loaded, 'carried.unplacedSleepingRecords', {
    'tab-elsewhere:x': { paneKey: 'tab-elsewhere:x', worktreeId: 'repo-9::/gone', prompt: 'p' }
  })
  fill(loaded, 'carried.unplacedIncarnations', { 'tab-elsewhere:x': 'inc-elsewhere' })
  fill(loaded, 'carried.unplacedClosedTabs', {
    'tab-elsewhere': { closedAt: 1, worktreeId: 'repo-9::/gone', reason: 'user' }
  })
  fill(loaded, 'carried.unownedTerminalLayouts', {
    'tab-gone': {
      root: { type: 'leaf', leafId: leaf(7) },
      activeLeafId: leaf(7),
      expandedLeafId: null
    }
  })
  return loaded
}

type Holder = Record<string, unknown>

type PrefixOf<Path> = Path extends `${infer Head}.${infer Rest}`
  ? Rest extends `${string}.${string}`
    ? `${Head}.${PrefixOf<Rest>}`
    : Head
  : never

function holdersOf(loaded: LoadedWorkspaceLayout, prefix: string): Holder[] {
  const { layout, desktopView: view, facts, carried } = loaded
  const workspaces = Object.values(layout.workspaces)
  const tabs = workspaces.flatMap((workspace) => workspace.tabs)
  const terminals = tabs.flatMap((entry) => (entry.kind === 'terminal' ? [entry] : []))
  const nested = <Value extends Holder>(record: Record<string, Record<string, Value>>) =>
    Object.values(record).flatMap((inner) => Object.values(inner))
  const leaves = workspaces.flatMap((workspace) => Object.values(workspace.leaves ?? {}))
  const holders: Record<PrefixOf<LayoutSource>, Holder[]> = {
    model: [layout],
    records: [layout.records],
    legacy: [layout.legacy],
    workspace: workspaces,
    tab: tabs,
    'tab.terminal': terminals.map((entry) => entry.terminal),
    'tab.panes': terminals.map((entry) => entry.panes),
    group: workspaces.flatMap((workspace) => workspace.groups),
    file: workspaces.flatMap((workspace) => workspace.editorFiles ?? []),
    browserTab: workspaces.flatMap((workspace) => workspace.browserTabs ?? []),
    leaf: leaves,
    'leaf.sleeping': leaves.flatMap((entry) => entry.sleeping ?? []),
    closedTab: workspaces.flatMap((workspace) => Object.values(workspace.closedTerminalTabs ?? {})),
    view: [view],
    viewGroup: nested(view.groups),
    viewPane: Object.values(view.panes),
    editorDraft: nested(view.editorDrafts),
    facts: [facts],
    terminalRow: Object.values(facts.terminalRows),
    scrollback: Object.values(facts.scrollback),
    browserLive: nested(facts.browserTabs),
    carried: [carried]
  }
  return new Map<string, Holder[]>(Object.entries(holders)).get(prefix)!
}

function splitSource(source: LayoutSource): [prefix: string, field: string] {
  const at = source.lastIndexOf('.')
  return [source.slice(0, at), source.slice(at + 1)]
}

function mutated(value: unknown): unknown {
  if (typeof value === 'string') {
    return `${value}~`
  }
  if (typeof value === 'number') {
    return value + 1
  }
  if (typeof value === 'boolean') {
    return !value
  }
  // A nullable field's other state.
  if (value === null) {
    return 'set'
  }
  if (Array.isArray(value)) {
    // Lists of ids are references: reorder them rather than rename them.
    return value.every((item) => typeof item !== 'object') ? value.toReversed() : value.map(mutated)
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, mutated(item)]))
  }
  return value
}

/** Disk field (`table.field`) → its values across every record, keyed by record. */
function diskValues(session: WorkspaceSessionState): Map<string, string> {
  const values = new Map<string, Record<string, unknown>>()
  for (const [table, records] of Object.entries(diskRecords(session))) {
    for (const [recordKey, record] of records) {
      for (const [field, value] of Object.entries(record)) {
        const name = `${table}.${field}`
        values.set(name, { ...values.get(name), [recordKey]: value })
      }
    }
  }
  return new Map([...values].map(([name, record]) => [name, stableJson(record)]))
}

const ALL_SOURCES = [...new Set([...WRITTEN_BY_FIELD.values(), TAB_LIST_ORDER].flatMap(sourcesOf))]

describe('each on-disk field has one source', () => {
  it('is typed over every disk, model and side-data field', () => {
    expect(everySourceIsWritten).toBe(true)
  })

  it('writes every copy of one fact from the same source', () => {
    for (const group of COPIES) {
      const sources = group.map((field) => {
        const written = writtenOf(field)
        return typeof written === 'string' ? written : written.from
      })
      expect(new Set(sources).size, group.join(' = ')).toBe(1)
    }
  })

  it('has every source populated, so a mutation can show what it writes', () => {
    const loaded = richLoaded()
    const empty = ALL_SOURCES.filter((source) => {
      const [prefix, field] = splitSource(source)
      return (
        !IDENTITY_SOURCES.has(source) &&
        !holdersOf(loaded, prefix).some((holder) => holder[field] != null)
      )
    })
    expect(empty).toEqual([])
  })

  it('changes on disk exactly the fields each source is declared for', () => {
    const base = richLoaded()
    const before = diskValues(saveWorkspaceLayout(base))
    const undeclared: string[] = []
    const ineffective: string[] = []
    for (const source of ALL_SOURCES.filter((entry) => !IDENTITY_SOURCES.has(entry))) {
      const loaded = structuredClone(base)
      const [prefix, field] = splitSource(source)
      for (const holder of holdersOf(loaded, prefix)) {
        holder[field] = mutated(holder[field])
      }
      const after = diskValues(saveWorkspaceLayout(loaded))
      const names = new Set([...before.keys(), ...after.keys()])
      const changed = [...names].filter((name) => before.get(name) !== after.get(name))
      for (const name of changed) {
        if (!sourcesOf(writtenOf(name)).includes(source)) {
          undeclared.push(`${source} -> ${name}`)
        }
      }
      for (const name of names) {
        const written = writtenOf(name)
        if (
          written &&
          typeof written !== 'string' &&
          written.from === source &&
          !changed.includes(name)
        ) {
          ineffective.push(`${source} -/-> ${name}`)
        }
      }
    }
    expect(undeclared, 'a source changed a disk field not declared to come from it').toEqual([])
    expect(ineffective, 'a declared source did not change its disk field').toEqual([])
  })
})
