// Renderer tab hydration and the renderer writer against the shared workspace-layout
// Loader/Serializer, on the same stored data. Expected throughout: both read the same tabs and groups.
import { describe, expect, it } from 'vitest'
import { LOCAL_EXECUTION_HOST_ID } from '../../../shared/execution-host'
import type { Tab, TabGroup } from '../../../shared/tab-types'
import type { TerminalLayoutSnapshot, TerminalTab } from '../../../shared/terminal-tab-types'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import { loadWorkspaceLayout } from '../../../shared/workspace-layout/workspace-layout-load'
import { nameBasedLoadContext } from '../../../shared/workspace-layout/workspace-layout-minted-ids'
import { checkLayoutRoundTrip } from '../../../shared/workspace-layout/workspace-layout-round-trip-check'
import { saveWorkspaceLayout } from '../../../shared/workspace-layout/workspace-layout-save'
import {
  addWorkspace,
  emptySession,
  GIT_KEY,
  leaf
} from '../../../shared/workspace-layout/workspace-layout-session.test-fixture'
import { buildHydratedTabState } from '../store/slices/tabs-hydration'
import { buildPersistedUnifiedTabSessionData } from './workspace-session-unified-tabs'
import { buildWorkspaceSessionPayload, type WorkspaceSessionSnapshot } from './workspace-session'

const KEY = GIT_KEY
const FILE_PATH = '/Users/dev/orca/src/app.ts'

/** What reaches disk: profile documents are JSON, so an undefined field is a missing one. */
function onDisk(session: WorkspaceSessionState): WorkspaceSessionState {
  return JSON.parse(JSON.stringify(session))
}

function sharedLoad(session: WorkspaceSessionState) {
  return loadWorkspaceLayout(LOCAL_EXECUTION_HOST_ID, session, nameBasedLoadContext())
}

function sharedSave(session: WorkspaceSessionState): WorkspaceSessionState {
  return onDisk(saveWorkspaceLayout(sharedLoad(session)))
}

function rendererHydrate(session: WorkspaceSessionState) {
  return buildHydratedTabState(session, new Set([KEY]))
}

function groupsListing(groups: readonly { id: string; tabOrder: string[] }[], tabId: string) {
  return groups.filter((group) => group.tabOrder.includes(tabId)).map((group) => group.id)
}

// --- Case 1: one tab id listed in two groups' tabOrder ---

function dualListedSession(storedOrder: 'group-1 first' | 'group-2 first'): WorkspaceSessionState {
  const session = addWorkspace(emptySession(), KEY, [
    { id: 'group-1', tabs: [{ id: 'tab-a', leaves: [[leaf(1)]] }] },
    {
      id: 'group-2',
      tabs: [
        { id: 'tab-t', leaves: [[leaf(2)]] },
        { id: 'tab-b', leaves: [[leaf(3)]] }
      ]
    }
  ])
  const [group1, group2] = session.tabGroups![KEY]!
  const corrupted = { ...group1!, tabOrder: ['tab-t', ...group1!.tabOrder] }
  session.tabGroups![KEY] =
    storedOrder === 'group-1 first' ? [corrupted, group2!] : [group2!, corrupted]
  return session
}

describe('case 1: group owner of a tab listed in two groups (tab entry says group-2)', () => {
  it('group-1 stored first: shared Loader and renderer hydration pick the same owner', () => {
    const session = dualListedSession('group-1 first')
    const shared = groupsListing(sharedLoad(session).layout.workspaces[KEY]!.groups, 'tab-t')
    const renderer = groupsListing(rendererHydrate(session).groupsByWorktree[KEY]!, 'tab-t')

    expect({ shared, renderer }).toEqual({ shared: renderer, renderer: ['group-2'] })
  })

  it('group-2 stored first (control): shared Loader and renderer hydration pick the same owner', () => {
    const session = dualListedSession('group-2 first')
    const shared = groupsListing(sharedLoad(session).layout.workspaces[KEY]!.groups, 'tab-t')
    const renderer = groupsListing(rendererHydrate(session).groupsByWorktree[KEY]!, 'tab-t')

    expect({ shared, renderer }).toEqual({ shared: renderer, renderer: ['group-2'] })
  })

  it('renderer hydration of the shared save keeps the tab in its own group', () => {
    const session = dualListedSession('group-1 first')
    const direct = groupsListing(rendererHydrate(session).groupsByWorktree[KEY]!, 'tab-t')
    const afterSharedSave = groupsListing(
      rendererHydrate(sharedSave(session)).groupsByWorktree[KEY]!,
      'tab-t'
    )

    expect(afterSharedSave).toEqual(direct)
  })
})

// --- Case 2: renderer writer output through the shared Loader/Serializer ---

const CREATED_AT = 1_700_000_000_000

function row(id: string, sortOrder: number): TerminalTab {
  return {
    id,
    ptyId: null,
    worktreeId: KEY,
    title: `Terminal ${sortOrder + 1}`,
    defaultTitle: `Terminal ${sortOrder + 1}`,
    customTitle: null,
    color: null,
    sortOrder,
    createdAt: CREATED_AT
  }
}

function paneLayout(leafId: string): TerminalLayoutSnapshot {
  return {
    root: { type: 'leaf', leafId },
    activeLeafId: leafId,
    expandedLeafId: null,
    ptyIdsByLeafId: {}
  }
}

function entry(
  id: string,
  groupId: string,
  overrides: Partial<Tab> & Pick<Tab, 'contentType' | 'sortOrder'>
): Tab {
  return {
    id,
    entityId: id,
    groupId,
    worktreeId: KEY,
    executionHostId: LOCAL_EXECUTION_HOST_ID,
    label: id,
    customLabel: null,
    color: null,
    createdAt: CREATED_AT,
    ...overrides
  }
}

function group(id: string, tabOrder: string[]): TabGroup {
  return {
    id,
    worktreeId: KEY,
    activeTabId: tabOrder[0] ?? null,
    tabOrder,
    recentTabIds: tabOrder.slice(0, 1)
  }
}

type SnapshotEdit = {
  extraTabs?: Tab[]
  extraRows?: TerminalTab[]
  groups?: TabGroup[]
}

/** A window's in-memory state for one worktree: two terminals, one editor file, two groups. */
function rendererSnapshot(edit: SnapshotEdit = {}): WorkspaceSessionSnapshot {
  const rows = [row('tab-a', 0), row('tab-b', 1), ...(edit.extraRows ?? [])]
  const tabs = [
    entry('tab-a', 'group-1', { contentType: 'terminal', label: 'Terminal 1', sortOrder: 0 }),
    entry('editor-tab-1', 'group-1', {
      contentType: 'editor',
      entityId: FILE_PATH,
      label: 'app.ts',
      sortOrder: 1
    }),
    entry('tab-b', 'group-2', { contentType: 'terminal', label: 'Terminal 2', sortOrder: 0 }),
    ...(edit.extraTabs ?? [])
  ]
  return {
    activeRepoId: 'repo-1',
    activeWorkspaceKey: null,
    activeWorktreeId: KEY,
    activeTabId: 'tab-a',
    tabsByWorktree: { [KEY]: rows },
    ptyIdsByTabId: {},
    terminalLayoutsByTabId: Object.fromEntries(
      rows.map((terminal, index) => [terminal.id, paneLayout(leaf(index + 1))])
    ),
    localOnlyScrollbackByTabId: {},
    activeTabIdByWorktree: { [KEY]: 'tab-a' },
    openFiles: [
      {
        id: FILE_PATH,
        filePath: FILE_PATH,
        relativePath: 'src/app.ts',
        worktreeId: KEY,
        language: 'typescript',
        isDirty: false,
        mode: 'edit'
      }
    ],
    editorDrafts: {},
    markdownFrontmatterVisible: {},
    activeFileIdByWorktree: {},
    activeTabTypeByWorktree: {},
    browserTabsByWorktree: {},
    browserPagesByWorkspace: {},
    remoteBrowserPageHandlesByPageId: {},
    activeBrowserTabIdByWorktree: {},
    browserUrlHistory: [],
    workspaceDocHistory: [],
    unifiedTabsByWorktree: { [KEY]: tabs },
    groupsByWorktree: {
      [KEY]: edit.groups ?? [
        group('group-1', ['tab-a', 'editor-tab-1']),
        group('group-2', ['tab-b'])
      ]
    },
    layoutByWorktree: {
      [KEY]: {
        type: 'split',
        direction: 'horizontal',
        ratio: 0.5,
        first: { type: 'leaf', groupId: 'group-1' },
        second: { type: 'leaf', groupId: 'group-2' }
      }
    },
    activeGroupIdByWorktree: { [KEY]: 'group-1' },
    sshConnectionStates: new Map(),
    repos: [],
    worktreesByRepo: {},
    lastKnownRelayPtyIdByTabId: {},
    lastVisitedAtByWorktreeId: {},
    defaultTerminalTabsAppliedByWorktreeId: {}
  }
}

const WRITER_INPUTS: [string, () => WorkspaceSessionSnapshot][] = [
  ['clean state', () => rendererSnapshot()],
  [
    'tab-b (entry says group-2) also listed first in group-1',
    () =>
      rendererSnapshot({
        groups: [group('group-1', ['tab-b', 'tab-a', 'editor-tab-1']), group('group-2', ['tab-b'])]
      })
  ],
  [
    'terminal whose groupId names a missing group (row kept, in no tabOrder)',
    () =>
      rendererSnapshot({
        extraRows: [row('tab-c', 2)],
        extraTabs: [entry('tab-c', 'group-gone', { contentType: 'terminal', sortOrder: 2 })]
      })
  ],
  [
    'editor tab whose groupId names a missing group (still in group-1 tabOrder)',
    () =>
      rendererSnapshot({
        extraTabs: [
          entry('editor-tab-2', 'group-gone', {
            contentType: 'editor',
            entityId: FILE_PATH,
            sortOrder: 2
          })
        ],
        groups: [
          group('group-1', ['tab-a', 'editor-tab-1', 'editor-tab-2']),
          group('group-2', ['tab-b'])
        ]
      })
  ]
]

function writerOutput(snapshot: WorkspaceSessionSnapshot): WorkspaceSessionState {
  return onDisk(buildWorkspaceSessionPayload(snapshot))
}

function tabIdsOf(tabs: readonly Tab[] | undefined): string[] {
  return (tabs ?? []).map((tab) => tab.id).sort()
}

describe('case 2: renderer writer output through shared load→save', () => {
  it('clean writer output loads with no changes', () => {
    const changes = sharedLoad(writerOutput(rendererSnapshot())).changes

    expect(changes.map((change) => `${change.table}.${change.field}`)).toEqual([])
  })

  it.each(WRITER_INPUTS)('%s: the shadow round-trip check has no findings', (_name, build) => {
    expect(checkLayoutRoundTrip(LOCAL_EXECUTION_HOST_ID, writerOutput(build())).findings).toEqual(
      []
    )
  })

  it.each(WRITER_INPUTS)('%s: a second save equals the first', (_name, build) => {
    const once = sharedSave(writerOutput(build()))

    expect(sharedSave(once)).toEqual(once)
  })

  it.each(WRITER_INPUTS)(
    '%s: shared save and renderer hydration restore the same tabs',
    (_name, build) => {
      const written = writerOutput(build())

      expect(tabIdsOf(sharedSave(written).unifiedTabs?.[KEY])).toEqual(
        tabIdsOf(rendererHydrate(written).unifiedTabsByWorktree[KEY])
      )
    }
  )

  it.each(WRITER_INPUTS)(
    '%s: shared save and renderer hydration restore the same groups',
    (_name, build) => {
      const written = writerOutput(build())
      const shared = (sharedSave(written).tabGroups?.[KEY] ?? []).map((g) => [g.id, g.tabOrder])
      const renderer = rendererHydrate(written).groupsByWorktree[KEY]!.map((g) => [
        g.id,
        g.tabOrder
      ])

      expect(shared).toEqual(renderer)
    }
  )
})

// --- Case 5: tabs renderer hydration drops ---

const DIFF_ID = `${KEY}::diff::unstaged::src/app.ts`
const HTML_PREVIEW_ID = `html-preview::${KEY}::${FILE_PATH}`
const CONFLICT_ID = `${KEY}::conflict-review::merge`

function hydrationDropsSession(): WorkspaceSessionState {
  const session = addWorkspace(emptySession(), KEY, [
    {
      id: 'group-1',
      tabs: [
        { id: 'tab-a', leaves: [[leaf(1)]] },
        { id: 'editor-tab-1', entityId: FILE_PATH, kind: 'editor' },
        { id: 'html-preview-tab', entityId: HTML_PREVIEW_ID, kind: 'editor' },
        { id: 'conflict-tab', entityId: CONFLICT_ID, kind: 'conflict-review' }
      ]
    },
    { id: 'group-diff', tabs: [{ id: 'diff-tab', entityId: DIFF_ID, kind: 'diff' }] }
  ])
  session.openFilesByWorktree = {
    [KEY]: [
      { filePath: FILE_PATH, relativePath: 'src/app.ts', worktreeId: KEY, language: 'typescript' }
    ]
  }
  return session
}

function keptBy(session: WorkspaceSessionState, tabId: string) {
  return {
    shared: tabIdsOf(sharedSave(session).unifiedTabs?.[KEY]).includes(tabId),
    renderer: tabIdsOf(rendererHydrate(session).unifiedTabsByWorktree[KEY]).includes(tabId)
  }
}

describe('case 5: live transient tabs stay in the model and are filtered at cold persistence', () => {
  it.each([
    ['editor tab whose file is persisted (control)', 'editor-tab-1'],
    ['diff tab alone in its group, file not persisted', 'diff-tab'],
    ['editor tab with an html-preview:: entity', 'html-preview-tab'],
    ['conflict-review tab whose entity is not a persisted file', 'conflict-tab']
  ])('%s: retained live and filtered by the renderer boundary', (_name, tabId) => {
    const kept = keptBy(hydrationDropsSession(), tabId)

    expect(kept.shared).toBe(true)
    expect(kept.renderer).toBe(tabId === 'editor-tab-1')
    const hydrated = rendererHydrate(hydrationDropsSession())
    const persisted = buildPersistedUnifiedTabSessionData({ ...hydrated, openFiles: [] })
    expect(
      tabIdsOf(sharedSave({ ...hydrationDropsSession(), ...persisted }).unifiedTabs?.[KEY])
    ).toEqual(tabIdsOf(hydrated.unifiedTabsByWorktree[KEY]))
  })

  it('only the live model retains the group holding a transient diff', () => {
    const session = hydrationDropsSession()
    const shared = (sharedSave(session).tabGroups?.[KEY] ?? []).map((g) => g.id)
    const renderer = rendererHydrate(session).groupsByWorktree[KEY]!.map((g) => g.id)

    expect(shared).toEqual(['group-1', 'group-diff'])
    expect(renderer).toEqual(['group-1'])
  })
})
