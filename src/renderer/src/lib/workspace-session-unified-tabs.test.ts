import { afterEach, describe, expect, it, vi } from 'vitest'
import type * as AgentStatusModule from '@/lib/agent-status'
import { LOCAL_EXECUTION_HOST_ID } from '../../../shared/execution-host'
import type { Tab, TabGroup, TabGroupLayoutNode } from '../../../shared/tab-types'
import { loadWorkspaceLayout } from '../../../shared/workspace-layout/workspace-layout-load'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import type { OpenFile } from '../store/slices/editor'
import { createStoreSessionMockApi } from '../store/slices/store-session-test-harness'
import { createTestStore, makeWorktree } from '../store/slices/store-test-helpers'
import { buildPersistedUnifiedTabSessionData } from './workspace-session-unified-tabs'
import {
  resetStructuredAgentLaunchPersistenceForTests,
  writeStructuredAgentLaunchRecord
} from './structured-agent-session-launch-persistence'
import { structuredAgentSessionTabId } from '../../../shared/structured-agent-session-projection'

vi.mock('sonner', () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }))
vi.mock('@/lib/agent-status', async (importOriginal) => {
  const actual = await importOriginal<typeof AgentStatusModule>()
  return { ...actual, detectAgentStatusFromTitle: vi.fn().mockReturnValue(null) }
})

createStoreSessionMockApi()

const WORKTREE_ID = 'repo-1::/x'

function editorTab(overrides: Partial<Tab> = {}): Tab {
  return {
    id: 'tab-1',
    entityId: '/x/README.md',
    groupId: 'group-1',
    worktreeId: WORKTREE_ID,
    contentType: 'editor',
    label: 'README.md',
    customLabel: null,
    color: null,
    sortOrder: 0,
    createdAt: 1,
    ...overrides
  }
}

describe('buildPersistedUnifiedTabSessionData', () => {
  it('writes one record for repeated tab ids', () => {
    const persisted = buildPersistedUnifiedTabSessionData({
      unifiedTabsByWorktree: { [WORKTREE_ID]: [editorTab(), editorTab()] },
      groupsByWorktree: {
        [WORKTREE_ID]: [
          { id: 'group-1', worktreeId: WORKTREE_ID, activeTabId: 'tab-1', tabOrder: ['tab-1'] }
        ]
      },
      layoutByWorktree: {},
      activeGroupIdByWorktree: {},
      openFiles: []
    })

    expect(persisted.unifiedTabs?.[WORKTREE_ID]?.map((tab) => tab.id)).toEqual(['tab-1'])
    expect(persisted.tabGroups?.[WORKTREE_ID]?.[0]?.tabOrder).toEqual(['tab-1'])
  })

  it('keeps the copy hydration would keep when one tab id spans two groups', () => {
    const stale = editorTab({
      groupId: 'group-1',
      sortOrder: 9,
      customLabel: 'stale',
      isPinned: false
    })
    const chosen = editorTab({
      groupId: 'group-2',
      sortOrder: 0,
      customLabel: 'chosen',
      isPinned: true
    })
    const persisted = buildPersistedUnifiedTabSessionData({
      unifiedTabsByWorktree: { [WORKTREE_ID]: [stale, chosen] },
      groupsByWorktree: {
        [WORKTREE_ID]: [
          { id: 'group-1', worktreeId: WORKTREE_ID, activeTabId: 'tab-1', tabOrder: ['tab-1'] },
          { id: 'group-2', worktreeId: WORKTREE_ID, activeTabId: 'tab-1', tabOrder: ['tab-1'] }
        ]
      },
      layoutByWorktree: {},
      activeGroupIdByWorktree: {},
      openFiles: []
    })

    expect(persisted.unifiedTabs?.[WORKTREE_ID]).toEqual([chosen])

    const store = createTestStore()
    store.setState({
      repos: [{ id: 'repo-1', path: '/x', displayName: 'Repo', badgeColor: '#000', addedAt: 0 }],
      worktreesByRepo: {
        'repo-1': [makeWorktree({ id: WORKTREE_ID, repoId: 'repo-1', path: '/x' })]
      }
    })
    const session: WorkspaceSessionState = {
      activeRepoId: 'repo-1',
      activeWorktreeId: null,
      activeTabId: null,
      tabsByWorktree: {},
      terminalLayoutsByTabId: {},
      ...persisted
    }
    store.getState().hydrateTabsSession(session)

    const hydrated = store.getState().unifiedTabsByWorktree[WORKTREE_ID] ?? []
    expect(hydrated.map((tab) => [tab.id, tab.groupId, tab.customLabel, tab.isPinned])).toEqual([
      ['tab-1', 'group-2', 'chosen', true]
    ])
  })

  it.each([
    editorTab({ contentType: 'diff', entityId: '/x/disappeared.ts', sortOrder: -1 }),
    editorTab({ entityId: 'html-preview::old-document', sortOrder: -1 }),
    editorTab({ contentType: 'terminal', entityId: 'runtime::old-terminal', sortOrder: -1 })
  ])('restores the live editor when its duplicate $contentType row cannot restore', (discarded) => {
    const editor = editorTab()
    const snapshot = {
      unifiedTabsByWorktree: { [WORKTREE_ID]: [discarded, editor] },
      groupsByWorktree: {
        [WORKTREE_ID]: [
          { id: 'group-1', worktreeId: WORKTREE_ID, activeTabId: 'tab-1', tabOrder: ['tab-1'] }
        ]
      },
      layoutByWorktree: {},
      activeGroupIdByWorktree: {},
      openFiles: [
        {
          id: editor.entityId,
          filePath: editor.entityId,
          relativePath: 'README.md',
          worktreeId: WORKTREE_ID,
          language: 'markdown',
          mode: 'edit' as const,
          isDirty: true
        }
      ]
    }
    const persisted = buildPersistedUnifiedTabSessionData(snapshot)
    const store = createTestStore()
    store.setState({
      repos: [{ id: 'repo-1', path: '/x', displayName: 'Repo', badgeColor: '#000', addedAt: 0 }],
      worktreesByRepo: {
        'repo-1': [makeWorktree({ id: WORKTREE_ID, repoId: 'repo-1', path: '/x' })]
      }
    })
    const session: WorkspaceSessionState = {
      activeRepoId: 'repo-1',
      activeWorktreeId: null,
      activeTabId: null,
      tabsByWorktree: {},
      terminalLayoutsByTabId: {},
      openFilesByWorktree: {
        [WORKTREE_ID]: [{ ...snapshot.openFiles[0], dirtyDraftContent: 'retained draft' }]
      },
      ...persisted
    }
    store.getState().hydrateTabsSession(session)
    store.getState().hydrateEditorSession(session)
    expect(store.getState().unifiedTabsByWorktree[WORKTREE_ID]).toEqual([editor])
    expect(store.getState().editorDrafts[editor.entityId]).toBe('retained draft')
  })
})

function editFile(filePath: string): OpenFile {
  return {
    id: filePath,
    filePath,
    relativePath: filePath.slice('/x/'.length),
    worktreeId: WORKTREE_ID,
    language: 'typescript',
    mode: 'edit',
    isDirty: false
  }
}

function group(id: string, tabOrder: string[], overrides: Partial<TabGroup> = {}): TabGroup {
  return { id, worktreeId: WORKTREE_ID, activeTabId: tabOrder[0] ?? null, tabOrder, ...overrides }
}

type WriterInput = Parameters<typeof buildPersistedUnifiedTabSessionData>[0]

function writerInput(
  tabs: Tab[],
  groups: TabGroup[],
  overrides: Partial<WriterInput> = {}
): WriterInput {
  return {
    unifiedTabsByWorktree: { [WORKTREE_ID]: tabs },
    groupsByWorktree: { [WORKTREE_ID]: groups },
    layoutByWorktree: {},
    activeGroupIdByWorktree: {},
    openFiles: [],
    ...overrides
  }
}

function savedSession(
  persisted: ReturnType<typeof buildPersistedUnifiedTabSessionData>,
  openFiles: OpenFile[]
): WorkspaceSessionState {
  return {
    activeRepoId: 'repo-1',
    activeWorktreeId: null,
    activeTabId: null,
    tabsByWorktree: {},
    terminalLayoutsByTabId: {},
    openFilesByWorktree: {
      [WORKTREE_ID]: openFiles.map(({ filePath, relativePath, worktreeId, language }) => ({
        filePath,
        relativePath,
        worktreeId,
        language
      }))
    },
    ...persisted
  }
}

function hydrate(session: WorkspaceSessionState): ReturnType<typeof createTestStore> {
  const store = createTestStore()
  store.setState({
    repos: [{ id: 'repo-1', path: '/x', displayName: 'Repo', badgeColor: '#000', addedAt: 0 }],
    worktreesByRepo: {
      'repo-1': [makeWorktree({ id: WORKTREE_ID, repoId: 'repo-1', path: '/x' })]
    }
  })
  store.getState().hydrateTabsSession(session)
  store.getState().hydrateEditorSession(session)
  return store
}

const groupOwnership = (groups: readonly Pick<TabGroup, 'id' | 'tabOrder'>[] | undefined) =>
  (groups ?? []).map(({ id, tabOrder }) => ({ id, tabOrder }))

describe('buildPersistedUnifiedTabSessionData group ownership', () => {
  it('drops an unrestorable diff tab from the tab order of the group that still shows an editor', () => {
    const editor = editorTab({ id: '/x/a.ts', entityId: '/x/a.ts' })
    const diff = editorTab({
      id: 'diff-tab',
      entityId: '/x/gone.ts',
      contentType: 'diff',
      sortOrder: 1
    })
    const persisted = buildPersistedUnifiedTabSessionData(
      writerInput(
        [editor, diff],
        [
          group('group-1', ['/x/a.ts', 'diff-tab'], {
            activeTabId: 'diff-tab',
            recentTabIds: ['diff-tab', '/x/a.ts', 'diff-tab']
          })
        ],
        { openFiles: [editFile('/x/a.ts')] }
      )
    )

    expect(persisted.unifiedTabs?.[WORKTREE_ID]?.map((tab) => tab.id)).toEqual(['/x/a.ts'])
    expect(persisted.tabGroups?.[WORKTREE_ID]).toEqual([
      group('group-1', ['/x/a.ts'], { activeTabId: null, recentTabIds: ['/x/a.ts'] })
    ])
  })

  it('lists a tab only in the group its own groupId names when two groups claim it', () => {
    const shared = editorTab({ id: '/x/a.ts', entityId: '/x/a.ts', groupId: 'group-2' })
    const other = editorTab({ id: '/x/b.ts', entityId: '/x/b.ts', groupId: 'group-1' })
    const persisted = buildPersistedUnifiedTabSessionData(
      writerInput(
        [shared, other],
        [
          group('group-1', ['/x/a.ts', '/x/b.ts'], {
            activeTabId: '/x/a.ts',
            recentTabIds: ['/x/b.ts', '/x/a.ts']
          }),
          group('group-2', ['/x/a.ts'])
        ],
        { openFiles: [editFile('/x/a.ts'), editFile('/x/b.ts')] }
      )
    )

    expect(persisted.tabGroups?.[WORKTREE_ID]).toEqual([
      group('group-1', ['/x/b.ts'], { activeTabId: null, recentTabIds: ['/x/b.ts'] }),
      group('group-2', ['/x/a.ts'], { recentTabIds: ['/x/a.ts'] })
    ])
  })

  it('removes a group whose tabs were all filtered, with its active pointer and layout leaf', () => {
    const editor = editorTab({ id: '/x/a.ts', entityId: '/x/a.ts', groupId: 'group-1' })
    const diff = editorTab({
      id: 'diff-tab',
      entityId: '/x/gone.ts',
      contentType: 'diff',
      groupId: 'group-2'
    })
    const layout: TabGroupLayoutNode = {
      type: 'split',
      direction: 'horizontal',
      first: { type: 'leaf', groupId: 'group-1' },
      second: { type: 'leaf', groupId: 'group-2' }
    }
    const persisted = buildPersistedUnifiedTabSessionData(
      writerInput([editor, diff], [group('group-1', ['/x/a.ts']), group('group-2', ['diff-tab'])], {
        layoutByWorktree: { [WORKTREE_ID]: layout },
        activeGroupIdByWorktree: { [WORKTREE_ID]: 'group-2' },
        openFiles: [editFile('/x/a.ts')]
      })
    )

    expect(groupOwnership(persisted.tabGroups?.[WORKTREE_ID])).toEqual([
      { id: 'group-1', tabOrder: ['/x/a.ts'] }
    ])
    expect(persisted.activeGroupIdByWorktree?.[WORKTREE_ID]).toBe('group-1')
    expect(persisted.tabGroupLayouts?.[WORKTREE_ID]).toEqual({ type: 'leaf', groupId: 'group-1' })
  })

  it('recovers valid tabs whose group is gone even when nobody lists them', () => {
    const listed = editorTab({ id: '/x/a.ts', entityId: '/x/a.ts', groupId: 'group-gone' })
    const unlisted = editorTab({ id: '/x/b.ts', entityId: '/x/b.ts', groupId: 'group-gone' })
    const persisted = buildPersistedUnifiedTabSessionData(
      writerInput([listed, unlisted], [group('group-1', ['/x/a.ts'])], {
        openFiles: [editFile('/x/a.ts'), editFile('/x/b.ts')]
      })
    )

    expect(persisted.unifiedTabs?.[WORKTREE_ID]).toEqual([
      { ...listed, groupId: 'group-1' },
      { ...unlisted, groupId: 'group-1' }
    ])
    expect(groupOwnership(persisted.tabGroups?.[WORKTREE_ID])).toEqual([
      { id: 'group-1', tabOrder: ['/x/a.ts', '/x/b.ts'] }
    ])
  })

  it('writes what it reads back, and the shared layout Loader places every tab in the same group', () => {
    const openFiles = [editFile('/x/a.ts'), editFile('/x/b.ts'), editFile('/x/c.ts')]
    const tabs = [
      editorTab({ id: '/x/a.ts', entityId: '/x/a.ts', groupId: 'group-1', sortOrder: 0 }),
      editorTab({ id: '/x/b.ts', entityId: '/x/b.ts', groupId: 'group-2', sortOrder: 1 }),
      editorTab({ id: '/x/c.ts', entityId: '/x/c.ts', groupId: 'group-gone', sortOrder: 2 }),
      editorTab({ id: 'diff-tab', entityId: '/x/b.ts', contentType: 'diff', groupId: 'group-2' })
    ]
    const first = buildPersistedUnifiedTabSessionData(
      writerInput(
        tabs,
        [
          group('group-1', ['/x/a.ts', '/x/b.ts', '/x/c.ts'], {
            activeTabId: '/x/b.ts',
            recentTabIds: ['/x/c.ts', '/x/b.ts', '/x/a.ts']
          }),
          group('group-2', ['/x/b.ts'], { activeTabId: null }),
          group('group-empty', [])
        ],
        {
          // Group 2 is missing from the layout; the write lays it out the way hydration does.
          layoutByWorktree: { [WORKTREE_ID]: { type: 'leaf', groupId: 'group-1' } },
          activeGroupIdByWorktree: { [WORKTREE_ID]: 'group-2' },
          openFiles
        }
      )
    )

    const store = hydrate(savedSession(first, openFiles))
    expect(buildPersistedUnifiedTabSessionData(store.getState())).toEqual(first)

    let minted = 0
    const loaded = loadWorkspaceLayout(LOCAL_EXECUTION_HOST_ID, savedSession(first, openFiles), {
      mintId: () => `minted-${++minted}`,
      mintLeafId: () => `00000000-0000-4000-8000-${String(++minted).padStart(12, '0')}`
    })
    expect(groupOwnership(loaded.layout.workspaces[WORKTREE_ID]?.groups)).toEqual(
      groupOwnership(first.tabGroups?.[WORKTREE_ID])
    )
  })
})

const WT = 'repo1::/path/wt1'

const terminalEntry: Tab = {
  id: 'tab-a',
  entityId: 'tab-a',
  groupId: 'kept',
  worktreeId: WT,
  contentType: 'terminal',
  label: 'Terminal 1',
  customLabel: null,
  color: null,
  sortOrder: 0,
  createdAt: 1
}

// Main closes a group with its last tab; the window may keep it shown empty. Its save must not
// bring that group back.
describe('buildPersistedUnifiedTabSessionData emptied groups', () => {
  it('saves no group the window holds empty, nor its place in the group tree', () => {
    const saved = buildPersistedUnifiedTabSessionData({
      unifiedTabsByWorktree: { [WT]: [terminalEntry] },
      groupsByWorktree: {
        [WT]: [
          { id: 'emptied', worktreeId: WT, activeTabId: null, tabOrder: [] },
          { id: 'kept', worktreeId: WT, activeTabId: 'tab-a', tabOrder: ['tab-a'] }
        ]
      },
      layoutByWorktree: {
        [WT]: {
          type: 'split',
          direction: 'horizontal',
          ratio: 0.5,
          first: { type: 'leaf', groupId: 'emptied' },
          second: { type: 'leaf', groupId: 'kept' }
        }
      },
      activeGroupIdByWorktree: { [WT]: 'emptied' },
      openFiles: []
    })

    expect(saved.tabGroups?.[WT]?.map((group) => group.id)).toEqual(['kept'])
    expect(saved.tabGroupLayouts?.[WT]).toEqual({ type: 'leaf', groupId: 'kept' })
    expect(saved.activeGroupIdByWorktree?.[WT]).toBe('kept')
  })

  it('saves nothing for a workspace whose only group the window holds empty', () => {
    const saved = buildPersistedUnifiedTabSessionData({
      unifiedTabsByWorktree: { [WT]: [] },
      groupsByWorktree: { [WT]: [{ id: 'root', worktreeId: WT, activeTabId: null, tabOrder: [] }] },
      layoutByWorktree: { [WT]: { type: 'leaf', groupId: 'root' } },
      activeGroupIdByWorktree: { [WT]: 'root' },
      openFiles: []
    })

    expect(saved.tabGroups).toEqual({})
    expect(saved.tabGroupLayouts).toEqual({})
  })
})

describe('buildPersistedUnifiedTabSessionData structured launch slots', () => {
  const slotId = structuredAgentSessionTabId('pending-chat')

  afterEach(() => {
    resetStructuredAgentLaunchPersistenceForTests()
  })

  it('keeps a pending launch slot in its group, with or without restorable tabs', () => {
    writeStructuredAgentLaunchRecord({
      sessionId: 'pending-chat',
      executionHostId: 'local',
      agent: 'claude',
      lifecycle: 'pending',
      clientOperationId: 'op',
      payloadFingerprint: 'fingerprint',
      expectedRuntimeFence: null,
      surfaceAddress: { worktreeId: WT, targetGroupId: 'kept', precedingTabIds: [] }
    })
    const group = { id: 'kept', worktreeId: WT, activeTabId: null, tabOrder: [slotId] }

    const slotOnly = buildPersistedUnifiedTabSessionData({
      unifiedTabsByWorktree: { [WT]: [] },
      groupsByWorktree: { [WT]: [group] },
      layoutByWorktree: {},
      activeGroupIdByWorktree: {},
      openFiles: []
    })
    expect(slotOnly.tabGroups?.[WT]?.[0]?.tabOrder).toEqual([slotId])

    const mixed = buildPersistedUnifiedTabSessionData({
      unifiedTabsByWorktree: { [WT]: [terminalEntry] },
      groupsByWorktree: { [WT]: [{ ...group, tabOrder: [slotId, 'tab-a'] }] },
      layoutByWorktree: {},
      activeGroupIdByWorktree: {},
      openFiles: []
    })
    expect(mixed.tabGroups?.[WT]?.[0]?.tabOrder).toEqual([slotId, 'tab-a'])
    expect(mixed.unifiedTabs?.[WT]?.map((tab) => tab.id)).toEqual(['tab-a'])
  })
})
