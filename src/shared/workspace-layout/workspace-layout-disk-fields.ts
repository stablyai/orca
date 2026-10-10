// Every on-disk field and the one model or side-data field it is written from. The Loader's
// change report diffs stored and saved sessions field by field over these tables, and the
// fact-location test checks each claim by mutating its source.

import type { SleepingAgentSessionRecord } from '../agent-session-resume'
import type { BrowserWorkspace } from '../browser-workspace-types'
import type { ClosedTerminalTabTombstone } from '../closed-terminal-tab-tombstones'
import type { Tab, TabGroup } from '../tab-types'
import type { TerminalLayoutSnapshot, TerminalTab } from '../terminal-tab-types'
import type { PersistedOpenFile } from '../workspace-session-state-types'
import {
  SESSION_FIELD_OWNERS,
  type BrowserTabLiveState,
  type CarriedSessionFields,
  type DesktopLayoutView,
  type EditorDraft,
  type LayoutContentFacts,
  type TerminalRowFacts
} from './workspace-layout-beside'
import type { LoadedWorkspaceLayout } from './workspace-layout-load-types'
import type {
  LayoutBrowserTab,
  LayoutClosedTab,
  LayoutContentTab,
  LayoutEditorFile,
  LayoutGroup,
  LayoutLeaf,
  LayoutSleepingRecord,
  LayoutTerminalCreation,
  LayoutTerminalPanes,
  LayoutTerminalTab,
  LegacyLayoutPersistence,
  WorkspaceLayout,
  WorkspaceLayoutModel,
  WorkspaceLayoutRecords
} from './workspace-layout-model'

type Prefixed<Prefix extends string, Key> = Key extends string ? `${Prefix}.${Key}` : never
type Inner<Map> = Map extends Record<string, Record<string, infer Value>> ? Value : never

/** Each part of a loaded layout, as `holder.field`; a list or map field is its own holder. */
type PartSources = {
  layout:
    | Prefixed<'model', Exclude<keyof WorkspaceLayoutModel, 'workspaces' | 'records' | 'legacy'>>
    | Prefixed<'records', keyof WorkspaceLayoutRecords>
    | Prefixed<'legacy', keyof LegacyLayoutPersistence>
    | Prefixed<
        'workspace',
        Exclude<
          keyof WorkspaceLayout,
          'tabs' | 'groups' | 'editorFiles' | 'browserTabs' | 'leaves' | 'closedTerminalTabs'
        >
      >
    | Prefixed<
        'tab',
        Exclude<keyof LayoutTerminalTab | keyof LayoutContentTab, 'terminal' | 'panes'>
      >
    | Prefixed<'tab.terminal', keyof LayoutTerminalCreation>
    | Prefixed<'tab.panes', keyof LayoutTerminalPanes>
    | Prefixed<'group', keyof LayoutGroup>
    | Prefixed<'file', keyof LayoutEditorFile>
    | Prefixed<'browserTab', keyof LayoutBrowserTab>
    // `$key`: the map key the entry is stored under.
    | Prefixed<'leaf', Exclude<keyof LayoutLeaf, 'sleeping'> | '$key'>
    | Prefixed<'leaf.sleeping', keyof LayoutSleepingRecord>
    | Prefixed<'closedTab', keyof LayoutClosedTab>
  desktopView:
    | Prefixed<'view', Exclude<keyof DesktopLayoutView, 'groups' | 'panes' | 'editorDrafts'>>
    | Prefixed<'viewGroup', keyof Inner<DesktopLayoutView['groups']>>
    | Prefixed<'viewPane', keyof DesktopLayoutView['panes'][string]>
    | Prefixed<'editorDraft', keyof EditorDraft>
  facts:
    | Prefixed<
        'facts',
        Exclude<keyof LayoutContentFacts, 'terminalRows' | 'scrollback' | 'browserTabs'>
      >
    | Prefixed<'terminalRow', keyof TerminalRowFacts>
    | Prefixed<'scrollback', keyof LayoutContentFacts['scrollback'][string]>
    | Prefixed<'browserLive', keyof BrowserTabLiveState>
  carried: Prefixed<'carried', keyof CarriedSessionFields>
}

/** Every field of the model and of the side data. A new part of a loaded layout fails here. */
export type LayoutSource = {
  [Part in keyof LoadedWorkspaceLayout]: PartSources[Part]
}[keyof LoadedWorkspaceLayout]

/** `from`: the one source. `via`: sources that only select or validate (a fallback, a filter). */
export type DiskFieldWritten =
  | { from: LayoutSource; via?: readonly LayoutSource[] }
  | 'unwritten'
  /** A map of per-workspace lists: only which keys it holds is compared. */
  | 'container'

const tab = <Field extends string>(field: Field) => ({ from: `tab.${field}` }) as const
const own = <Prefix extends string, Field extends string>(prefix: Prefix, field: Field) =>
  ({ from: `${prefix}.${field}` }) as const
const WORKTREE = { from: 'workspace.worktreeId' } as const
const TAB_ORDER = { from: 'group.tabOrder' } as const

const SHARED_TAB_FIELDS = {
  createdAt: tab('createdAt'),
  color: tab('color'),
  aiVaultTitle: tab('aiVaultTitle'),
  quickCommandLabel: tab('quickCommandLabel'),
  isPinned: tab('isPinned'),
  viewMode: tab('viewMode')
} as const

const ROW = {
  ...SHARED_TAB_FIELDS,
  id: tab('entityId'),
  ptyId: { from: 'leaf.ptyId', via: ['tab.panes.root', 'viewPane.activeLeafId'] },
  worktreeId: WORKTREE,
  title: own('terminalRow', 'title'),
  defaultTitle: own('tab.terminal', 'defaultTitle'),
  generatedTitle: tab('generatedTitle'),
  customTitle: tab('customTitle'),
  sortOrder: TAB_ORDER,
  generation: own('terminalRow', 'generation'),
  shellOverride: own('tab.terminal', 'shellOverride'),
  forceHostRuntime: own('tab.terminal', 'forceHostRuntime'),
  startupCwd: own('tab.terminal', 'startupCwd'),
  launchAgent: own('tab.terminal', 'launchAgent'),
  agentLaunchPane: own('tab.terminal', 'agentLaunchPane'),
  // Transient handoffs, never restored; the window strips them, but main's minimal row mint
  // stores `pendingActivationSpawn`, so the Loader drops it.
  pendingActivationSpawn: 'unwritten',
  recovery: 'unwritten',
  restoredFromSession: 'unwritten'
} as const satisfies Record<keyof TerminalTab, DiskFieldWritten>

const ENTRY_FIELDS = {
  ...SHARED_TAB_FIELDS,
  id: tab('id'),
  entityId: tab('entityId'),
  groupId: own('group', 'id'),
  worktreeId: WORKTREE,
  contentType: tab('kind'),
  generatedLabel: tab('generatedTitle'),
  customLabel: tab('customTitle'),
  sortOrder: TAB_ORDER,
  isPreview: tab('isPreview'),
  agentSessionAgent: tab('agentSessionAgent'),
  lastFocusedAt: own('view', 'lastFocusedAt')
} as const

const TERMINAL_ENTRY = {
  ...ENTRY_FIELDS,
  executionHostId: own('model', 'hostId'),
  label: own('terminalRow', 'title')
} as const satisfies Record<keyof Tab, DiskFieldWritten>

const CONTENT_ENTRY = {
  ...ENTRY_FIELDS,
  executionHostId: {
    from: 'model.hostId',
    via: ['file.externalSshTargetId', 'file.runtimeEnvironmentId']
  },
  label: own('facts', 'tabLabels')
} as const satisfies Record<keyof Tab, DiskFieldWritten>

const GROUP = {
  id: own('group', 'id'),
  worktreeId: WORKTREE,
  activeTabId: { from: 'viewGroup.activeTabId', via: ['group.tabOrder'] },
  tabOrder: TAB_ORDER,
  recentTabIds: { from: 'viewGroup.recentTabIds', via: ['group.tabOrder'] }
} as const satisfies Record<keyof TabGroup, DiskFieldWritten>

const LAYOUT = {
  root: own('tab.panes', 'root'),
  activeLeafId: { from: 'viewPane.activeLeafId', via: ['tab.panes.root'] },
  expandedLeafId: { from: 'viewPane.expandedLeafId', via: ['tab.panes.root'] },
  chatLeafId: own('tab.panes', 'chatLeafId'),
  ptyIdsByLeafId: { from: 'leaf.ptyId', via: ['tab.panes.root'] },
  buffersByLeafId: { from: 'scrollback.buffer', via: ['tab.panes.root'] },
  scrollbackRefsByLeafId: { from: 'scrollback.scrollbackRef', via: ['tab.panes.root'] },
  titlesByLeafId: { from: 'leaf.title', via: ['tab.panes.root'] }
} as const satisfies Record<keyof TerminalLayoutSnapshot, DiskFieldWritten>

const FILE = {
  filePath: own('file', 'filePath'),
  relativePath: own('file', 'relativePath'),
  worktreeId: WORKTREE,
  language: own('file', 'language'),
  isPreview: tab('isPreview'),
  runtimeEnvironmentId: own('file', 'runtimeEnvironmentId'),
  externalSshTargetId: own('file', 'externalSshTargetId'),
  dirtyDraftContent: own('editorDraft', 'dirtyDraftContent'),
  lastKnownDiskSignature: own('editorDraft', 'lastKnownDiskSignature'),
  readOnly: own('file', 'readOnly'),
  liveTail: own('file', 'liveTail')
} as const satisfies Record<keyof PersistedOpenFile, DiskFieldWritten>

const BROWSER = {
  id: own('browserTab', 'id'),
  worktreeId: WORKTREE,
  label: own('browserTab', 'label'),
  sessionProfileId: own('browserTab', 'sessionProfileId'),
  sessionPartition: own('browserTab', 'sessionPartition'),
  pageIds: own('browserTab', 'pageIds'),
  createdAt: own('browserTab', 'createdAt'),
  activePageId: own('browserLive', 'activePageId'),
  url: own('browserLive', 'url'),
  title: own('browserLive', 'title'),
  loading: own('browserLive', 'loading'),
  faviconUrl: own('browserLive', 'faviconUrl'),
  canGoBack: own('browserLive', 'canGoBack'),
  canGoForward: own('browserLive', 'canGoForward'),
  loadError: own('browserLive', 'loadError'),
  docLocation: own('browserLive', 'docLocation')
} as const satisfies Record<keyof BrowserWorkspace, DiskFieldWritten>

// A pane's records are written for the panes its tab's tree holds, under a key derived from
// where it sits: its tab's id and its leaf id.
const PANE_KEY = { from: 'leaf.$key', via: ['tab.entityId', 'tab.panes.root'] } as const
const paneRecord = <Source extends `leaf.${string}`>(from: Source) =>
  ({ from, via: ['tab.panes.root'] }) as const

const SLEEPING = {
  paneKey: PANE_KEY,
  tabId: PANE_KEY,
  worktreeId: { from: 'workspace.worktreeId', via: ['tab.panes.root'] },
  agent: paneRecord('leaf.sleeping.agent'),
  providerSession: paneRecord('leaf.sleeping.providerSession'),
  prompt: paneRecord('leaf.sleeping.prompt'),
  state: paneRecord('leaf.sleeping.state'),
  capturedAt: paneRecord('leaf.sleeping.capturedAt'),
  updatedAt: paneRecord('leaf.sleeping.updatedAt'),
  terminalTitle: paneRecord('leaf.sleeping.terminalTitle'),
  lastAssistantMessage: paneRecord('leaf.sleeping.lastAssistantMessage'),
  interrupted: paneRecord('leaf.sleeping.interrupted'),
  mainAgent: paneRecord('leaf.sleeping.mainAgent'),
  connectionId: paneRecord('leaf.sleeping.connectionId'),
  launchConfig: paneRecord('leaf.sleeping.launchConfig'),
  origin: paneRecord('leaf.sleeping.origin'),
  restoreOnTabOpenOnly: paneRecord('leaf.sleeping.restoreOnTabOpenOnly')
} as const satisfies Record<keyof SleepingAgentSessionRecord, DiskFieldWritten>

/** One entry of today's incarnation map, by pane key. */
const INCARNATION = {
  incarnationId: paneRecord('leaf.incarnationId')
} as const satisfies Record<'incarnationId', DiskFieldWritten>

const CLOSED_TAB = {
  closedAt: own('closedTab', 'closedAt'),
  worktreeId: WORKTREE,
  reason: own('closedTab', 'reason')
} as const satisfies Record<keyof ClosedTerminalTabTombstone, DiskFieldWritten>

type LayoutOwnedSessionField = {
  [Key in keyof typeof SESSION_FIELD_OWNERS]: (typeof SESSION_FIELD_OWNERS)[Key] extends
    | 'layout'
    | 'legacy'
    ? Key
    : never
}[keyof typeof SESSION_FIELD_OWNERS]

/** Session fields the layout writes; the view's, facts' and carried fields come from their owner. */
const LAYOUT_SESSION = {
  clientHostedBrowserPagesByWorktree: own('records', 'clientHostedBrowserPagesByWorkspace'),
  defaultTerminalTabsAppliedByWorktreeId: own('records', 'defaultTabsAppliedByWorkspace'),
  terminalTopologyRevisionByRepoId: own('legacy', 'topologyRevisionByRepoId'),
  tabGroupLayouts: { from: 'workspace.groupLayout', via: ['group.id'] },
  // Which workspaces keep a (possibly empty) terminal row list.
  tabsByWorktree: own('legacy', 'terminalRowOwners'),
  // Entries no terminal tab, pane or workspace owns, carried as stored; the rest are own tables.
  terminalLayoutsByTabId: own('carried', 'unownedTerminalLayouts'),
  sleepingAgentSessionsByPaneKey: own('carried', 'unplacedSleepingRecords'),
  terminalPtyIncarnationsByPaneKey: own('carried', 'unplacedIncarnations'),
  closedTerminalTabTombstonesByTabId: own('carried', 'unplacedClosedTabs'),
  unifiedTabs: 'container',
  tabGroups: 'container',
  openFilesByWorktree: 'container',
  browserTabsByWorktree: 'container',
  // Applied and cleared by the Loader.
  terminalSurfaceTombstonesByPaneKey: 'unwritten'
} as const satisfies Record<LayoutOwnedSessionField, DiskFieldWritten>

const OWNER_PREFIX = { view: 'view', fact: 'facts', carried: 'carried' } as const

function sessionFields(): Record<string, DiskFieldWritten> {
  const fields: Record<string, DiskFieldWritten> = { ...LAYOUT_SESSION }
  for (const [field, owner] of Object.entries(SESSION_FIELD_OWNERS)) {
    if (owner === 'view' || owner === 'fact' || owner === 'carried') {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: SESSION_FIELD_OWNERS types `field` as a key of the view, facts or carried fields.
      fields[field] = { from: `${OWNER_PREFIX[owner]}.${field}` as LayoutSource }
    }
  }
  return fields
}

export const DISK_TABLES = {
  row: ROW,
  terminalEntry: TERMINAL_ENTRY,
  entry: CONTENT_ENTRY,
  group: GROUP,
  layout: LAYOUT,
  file: FILE,
  browser: BROWSER,
  sleeping: SLEEPING,
  incarnation: INCARNATION,
  closedTab: CLOSED_TAB,
  session: sessionFields()
} as const

export type DiskTable = keyof typeof DISK_TABLES

type TableEntry = {
  [
    Table in Exclude<DiskTable, 'session'>
  ]: (typeof DISK_TABLES)[Table][keyof (typeof DISK_TABLES)[Table]]
}[Exclude<DiskTable, 'session'>]
type FromOf<Entry> = Entry extends { from: infer From } ? From : never

/** Sources no disk field is written from; must stay `never`. */
export type UnwrittenLayoutSource = Exclude<
  LayoutSource,
  | FromOf<TableEntry | (typeof LAYOUT_SESSION)[LayoutOwnedSessionField]>
  | Prefixed<'view', Exclude<keyof typeof SESSION_FIELD_OWNERS, LayoutOwnedSessionField>>
  | Prefixed<'facts', Exclude<keyof typeof SESSION_FIELD_OWNERS, LayoutOwnedSessionField>>
  | Prefixed<'carried', Exclude<keyof typeof SESSION_FIELD_OWNERS, LayoutOwnedSessionField>>
>
