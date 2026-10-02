import { describe, expect, it } from 'vitest'
import { buildEditorSessionData, buildWorkspaceSessionPayload } from './workspace-session'
import type { AppState } from '../store'
import type { OpenFile } from '../store/slices/editor'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../shared/constants'

function createSnapshot(overrides: Partial<AppState> = {}): AppState {
  return {
    activeRepoId: 'repo-1',
    activeWorktreeId: 'wt-1',
    activeTabId: 'tab-1',
    tabsByWorktree: {
      'wt-1': [{ id: 'tab-1', title: 'shell', ptyId: 'pty-1', worktreeId: 'wt-1' }],
      'wt-2': [{ id: 'tab-2', title: 'editor', ptyId: null, worktreeId: 'wt-2' }]
    },
    ptyIdsByTabId: {
      'tab-1': ['pty-1'],
      'tab-2': []
    },
    terminalLayoutsByTabId: {
      'tab-1': { root: null, activeLeafId: null, expandedLeafId: null }
    },
    activeTabIdByWorktree: { 'wt-1': 'tab-1', 'wt-2': 'tab-2' },
    editorDrafts: {},
    markdownFrontmatterVisible: {},
    openFiles: [
      {
        id: '/tmp/demo.ts',
        filePath: '/tmp/demo.ts',
        relativePath: 'demo.ts',
        worktreeId: 'wt-1',
        language: 'typescript',
        mode: 'edit',
        isDirty: false,
        isPreview: false,
        content: '',
        originalContent: ''
      },
      {
        id: '/tmp/demo.diff',
        filePath: '/tmp/demo.diff',
        relativePath: 'demo.diff',
        worktreeId: 'wt-1',
        language: 'diff',
        mode: 'diff',
        isDirty: false,
        isPreview: false,
        content: '',
        originalContent: ''
      }
    ],
    activeFileIdByWorktree: { 'wt-1': '/tmp/demo.ts' },
    activeTabTypeByWorktree: { 'wt-1': 'editor', 'wt-2': 'terminal' },
    browserTabsByWorktree: {
      'wt-1': [
        {
          id: 'browser-1',
          url: 'https://example.com',
          title: 'Example',
          loading: true,
          canGoBack: false,
          canGoForward: false,
          errorCode: null,
          errorDescription: null
        }
      ]
    },
    activeBrowserTabIdByWorktree: { 'wt-1': 'browser-1' },
    lastKnownRelayPtyIdByTabId: {},
    sshConnectionStates: new Map(),
    repos: [],
    worktreesByRepo: {},
    browserPagesByWorkspace: {
      'browser-1': [
        {
          id: 'page-1',
          workspaceId: 'browser-1',
          worktreeId: 'wt-1',
          url: 'https://example.com',
          title: 'Example',
          loading: true,
          faviconUrl: null,
          canGoBack: false,
          canGoForward: false,
          loadError: null,
          createdAt: Date.now()
        }
      ]
    },
    browserUrlHistory: [],
    remoteBrowserPageHandlesByPageId: {},
    ...overrides
  } as AppState
}

function createRepo(id: string, connectionId: string | null): AppState['repos'][number] {
  return {
    id,
    path: `/${id}`,
    displayName: id,
    badgeColor: '#fff',
    addedAt: 1,
    connectionId
  }
}

describe('buildWorkspaceSessionPayload', () => {
  it('preserves activeWorktreeIdsOnShutdown for full replacement writes', () => {
    const payload = buildWorkspaceSessionPayload(createSnapshot())

    expect(payload.activeWorktreeIdsOnShutdown).toEqual(['wt-1'])
  })

  it('persists the default-tab idempotency marker when present', () => {
    const payload = buildWorkspaceSessionPayload(
      createSnapshot({
        defaultTerminalTabsAppliedByWorktreeId: { 'wt-1': true }
      })
    )

    expect(payload.defaultTerminalTabsAppliedByWorktreeId).toEqual({ 'wt-1': true })
  })

  it('persists floating terminal tabs for daemon reattach after restart', () => {
    const payload = buildWorkspaceSessionPayload(
      createSnapshot({
        tabsByWorktree: {
          [FLOATING_TERMINAL_WORKTREE_ID]: [
            {
              id: 'floating-tab-1',
              title: 'Terminal 1',
              ptyId: 'floating-pty-1',
              worktreeId: FLOATING_TERMINAL_WORKTREE_ID
            } as never
          ]
        },
        terminalLayoutsByTabId: {
          'floating-tab-1': {
            root: null,
            activeLeafId: null,
            expandedLeafId: null,
            buffersByLeafId: { 'pane:1': 'floating-scrollback' },
            ptyIdsByLeafId: { 'pane:1': 'floating-pty-1' }
          }
        },
        activeTabIdByWorktree: {
          [FLOATING_TERMINAL_WORKTREE_ID]: 'floating-tab-1'
        },
        ptyIdsByTabId: {
          'floating-tab-1': ['floating-pty-1']
        }
      })
    )

    expect(payload.tabsByWorktree[FLOATING_TERMINAL_WORKTREE_ID]).toHaveLength(1)
    expect(payload.activeTabIdByWorktree?.[FLOATING_TERMINAL_WORKTREE_ID]).toBe('floating-tab-1')
    expect(payload.terminalLayoutsByTabId['floating-tab-1'].buffersByLeafId).toBeUndefined()
    expect(payload.terminalLayoutsByTabId['floating-tab-1'].ptyIdsByLeafId).toEqual({
      'pane:1': 'floating-pty-1'
    })
    expect(payload.activeWorktreeIdsOnShutdown).toEqual([FLOATING_TERMINAL_WORKTREE_ID])
  })

  it('persists only edit-mode files and resets browser loading state', () => {
    const payload = buildWorkspaceSessionPayload(createSnapshot())

    expect(payload.openFilesByWorktree).toEqual({
      'wt-1': [
        {
          filePath: '/tmp/demo.ts',
          relativePath: 'demo.ts',
          worktreeId: 'wt-1',
          language: 'typescript',
          isPreview: undefined
        }
      ]
    })
    expect(payload.browserTabsByWorktree?.['wt-1'][0].loading).toBe(false)
  })

  it('persists front-matter hide overrides only for restored editor files', () => {
    const payload = buildWorkspaceSessionPayload(
      createSnapshot({
        markdownFrontmatterVisible: {
          '/tmp/demo.ts': false,
          '/tmp/demo.diff': false,
          '/tmp/closed.md': false
        }
      })
    )

    expect(payload.markdownFrontmatterVisible).toEqual({ '/tmp/demo.ts': false })
  })

  it('does not persist empty split groups from transient simulator tab creation', () => {
    const payload = buildWorkspaceSessionPayload(
      createSnapshot({
        unifiedTabsByWorktree: {
          'wt-1': [
            {
              id: 'term-unified-1',
              entityId: 'tab-1',
              groupId: 'group-left',
              worktreeId: 'wt-1',
              contentType: 'terminal',
              label: 'shell',
              customLabel: null,
              color: null,
              sortOrder: 0,
              createdAt: 1
            }
          ]
        },
        groupsByWorktree: {
          'wt-1': [
            {
              id: 'group-left',
              worktreeId: 'wt-1',
              activeTabId: 'term-unified-1',
              tabOrder: ['term-unified-1']
            },
            {
              id: 'group-right',
              worktreeId: 'wt-1',
              activeTabId: null,
              tabOrder: []
            }
          ]
        },
        layoutByWorktree: {
          'wt-1': {
            type: 'split',
            direction: 'horizontal',
            first: { type: 'leaf', groupId: 'group-left' },
            second: { type: 'leaf', groupId: 'group-right' },
            ratio: 0.5
          }
        },
        activeGroupIdByWorktree: { 'wt-1': 'group-right' }
      })
    )

    expect(payload.tabGroups?.['wt-1']).toEqual([
      expect.objectContaining({ id: 'group-left', tabOrder: ['term-unified-1'] })
    ])
    expect(payload.tabGroupLayouts?.['wt-1']).toEqual({ type: 'leaf', groupId: 'group-left' })
    expect(payload.activeGroupIdByWorktree?.['wt-1']).toBe('group-left')
  })

  it('does not persist a browser tab whose create never materialized', () => {
    const payload = buildWorkspaceSessionPayload(
      createSnapshot({
        browserTabsByWorktree: {
          'wt-1': [
            {
              id: 'browser-1',
              activePageId: 'page-1',
              pageIds: ['page-1'],
              worktreeId: 'wt-1'
            } as never,
            {
              id: 'staged-1',
              activePageId: 'staged-page',
              pageIds: ['staged-page'],
              worktreeId: 'wt-1'
            } as never
          ]
        },
        browserPagesByWorkspace: {
          'browser-1': [{ id: 'page-1', workspaceId: 'browser-1', worktreeId: 'wt-1' } as never],
          'staged-1': [{ id: 'staged-page', workspaceId: 'staged-1', worktreeId: 'wt-1' } as never]
        },
        remoteBrowserPageHandlesByPageId: {
          'page-1': { environmentId: 'env-1', remotePageId: 'remote-1' },
          'staged-page': { environmentId: 'env-1', remotePageId: 'staged-page', staged: true }
        },
        activeBrowserTabIdByWorktree: { 'wt-1': 'staged-1' },
        unifiedTabsByWorktree: {
          'wt-1': [
            {
              id: 'browser-unified-1',
              entityId: 'browser-1',
              groupId: 'group-left',
              worktreeId: 'wt-1',
              contentType: 'browser',
              label: 'Example',
              customLabel: null,
              color: null,
              sortOrder: 0,
              createdAt: 1
            },
            {
              id: 'staged-unified-1',
              entityId: 'staged-1',
              groupId: 'group-left',
              worktreeId: 'wt-1',
              contentType: 'browser',
              label: 'New Tab',
              customLabel: null,
              color: null,
              sortOrder: 1,
              createdAt: 2
            }
          ]
        },
        groupsByWorktree: {
          'wt-1': [
            {
              id: 'group-left',
              worktreeId: 'wt-1',
              activeTabId: 'staged-unified-1',
              tabOrder: ['browser-unified-1', 'staged-unified-1']
            }
          ]
        },
        layoutByWorktree: { 'wt-1': { type: 'leaf', groupId: 'group-left' } },
        activeGroupIdByWorktree: { 'wt-1': 'group-left' }
      })
    )

    expect(payload.browserTabsByWorktree?.['wt-1']?.map((tab) => tab.id)).toEqual(['browser-1'])
    expect(payload.browserPagesByWorkspace).not.toHaveProperty('staged-1')
    expect(payload.unifiedTabs?.['wt-1']?.map((tab) => tab.id)).toEqual(['browser-unified-1'])
    // The group must not keep a slot pointing at a tab that no longer exists.
    expect(payload.tabGroups?.['wt-1']).toEqual([
      expect.objectContaining({ tabOrder: ['browser-unified-1'], activeTabId: null })
    ])
    expect(payload.activeBrowserTabIdByWorktree?.['wt-1']).toBeNull()
  })

  // Why: the handle map is in-memory only. Without stamping the remote page identity onto the row
  // that reaches disk, a relaunch has nothing to rebuild the handle from and the restored tab
  // silently downgrades to a fresh server page.
  it('stamps the remote page identity of a client-hosted browser page onto its persisted row', () => {
    const payload = buildWorkspaceSessionPayload(
      createSnapshot({
        remoteBrowserPageHandlesByPageId: {
          'page-1': {
            environmentId: 'env-1',
            remotePageId: 'remote-page-1',
            placement: {
              kind: 'client',
              browserHostClientId: 'host-a',
              browserHostGeneration: 2,
              pageHostGeneration: 4
            }
          }
        }
      })
    )

    expect(payload.browserPagesByWorkspace?.['browser-1']?.[0]).toMatchObject({
      remoteBrowserPageId: 'remote-page-1',
      remoteBrowserPageClientHosted: true
    })
  })

  it('marks a server-hosted remote page row with its remote page id but not client hosting', () => {
    const payload = buildWorkspaceSessionPayload(
      createSnapshot({
        remoteBrowserPageHandlesByPageId: {
          'page-1': { environmentId: 'env-1', remotePageId: 'remote-page-1' }
        }
      })
    )

    expect(payload.browserPagesByWorkspace?.['browser-1']?.[0]).toMatchObject({
      remoteBrowserPageId: 'remote-page-1'
    })
    expect(
      payload.browserPagesByWorkspace?.['browser-1']?.[0].remoteBrowserPageClientHosted
    ).toBeUndefined()
  })

  // Why: a row restored from a previous quit has no placement until the host republishes it, so
  // reading client hosting off the placement alone would lose the marker on a second quit.
  it('keeps the client-hosted marker on a restored row the host has not republished yet', () => {
    const payload = buildWorkspaceSessionPayload(
      createSnapshot({
        remoteBrowserPageHandlesByPageId: {
          'page-1': {
            environmentId: 'env-1',
            remotePageId: 'remote-page-1',
            restoredFromSession: true,
            restoredClientHosted: true
          }
        }
      })
    )

    expect(payload.browserPagesByWorkspace?.['browser-1']?.[0]).toMatchObject({
      remoteBrowserPageId: 'remote-page-1',
      remoteBrowserPageClientHosted: true
    })
  })

  it('drops local terminal scrollback buffers from session payloads', () => {
    const localWorktreeId = 'repo-1::/local/worktree'
    const payload = buildWorkspaceSessionPayload(
      createSnapshot({
        tabsByWorktree: {
          [localWorktreeId]: [
            {
              id: 'tab-local',
              title: 'shell',
              ptyId: 'pty-1',
              worktreeId: localWorktreeId
            } as never
          ]
        },
        ptyIdsByTabId: {
          'tab-local': ['pty-1']
        },
        terminalLayoutsByTabId: {
          'tab-local': {
            root: null,
            activeLeafId: null,
            expandedLeafId: null,
            buffersByLeafId: { 'pane:1': 'serialized-local-scrollback' },
            scrollbackRefsByLeafId: { 'pane:1': 'v1-local' },
            ptyIdsByLeafId: { 'pane:1': 'pty-1' },
            titlesByLeafId: { 'pane:1': 'build' }
          }
        },
        repos: [createRepo('repo-1', null)]
      })
    )

    expect(payload.terminalLayoutsByTabId['tab-local']).toEqual({
      root: null,
      activeLeafId: null,
      expandedLeafId: null,
      ptyIdsByLeafId: { 'pane:1': 'pty-1' },
      titlesByLeafId: { 'pane:1': 'build' }
    })
  })

  it('preserves SSH terminal scrollback buffers because relay teardown has no local history', () => {
    const sshWorktreeId = 'repo-ssh::/remote/worktree'
    const payload = buildWorkspaceSessionPayload(
      createSnapshot({
        tabsByWorktree: {
          [sshWorktreeId]: [
            {
              id: 'tab-ssh',
              title: 'remote',
              ptyId: 'relay-pty-1',
              worktreeId: sshWorktreeId
            } as never
          ]
        },
        ptyIdsByTabId: {
          'tab-ssh': ['relay-pty-1']
        },
        terminalLayoutsByTabId: {
          'tab-ssh': {
            root: null,
            activeLeafId: null,
            expandedLeafId: null,
            buffersByLeafId: { 'pane:1': 'serialized-remote-scrollback' },
            ptyIdsByLeafId: { 'pane:1': 'relay-pty-1' }
          }
        },
        repos: [createRepo('repo-ssh', 'conn-1')]
      })
    )

    expect(payload.terminalLayoutsByTabId['tab-ssh'].buffersByLeafId).toEqual({
      'pane:1': 'serialized-remote-scrollback'
    })
  })

  it('uses lastKnownRelayPtyIdByTabId fallback for disconnected SSH worktrees', () => {
    const payload = buildWorkspaceSessionPayload(
      createSnapshot({
        tabsByWorktree: {
          'wt-1': [{ id: 'tab-1', title: 'shell', ptyId: 'pty-1', worktreeId: 'wt-1' } as never],
          'wt-ssh': [{ id: 'tab-ssh', title: 'remote', ptyId: null, worktreeId: 'wt-ssh' } as never]
        },
        ptyIdsByTabId: {
          'tab-1': ['pty-1'],
          'tab-ssh': []
        },
        lastKnownRelayPtyIdByTabId: { 'tab-ssh': 'relay-sess-42' },
        repos: [createRepo('repo-ssh', 'conn-1')],
        worktreesByRepo: {
          'repo-ssh': [{ id: 'wt-ssh', repoId: 'repo-ssh' } as never]
        },
        sshConnectionStates: new Map([
          ['conn-1', { status: 'connected', targetId: 'conn-1', error: null, reconnectAttempt: 0 }]
        ]) as never
      })
    )

    expect(payload.activeWorktreeIdsOnShutdown).toContain('wt-ssh')
    expect(payload.remoteSessionIdsByTabId).toEqual({ 'tab-ssh': 'relay-sess-42' })
    expect(payload.activeConnectionIdsAtShutdown).toEqual(['conn-1'])
  })

  it('drops transient active editor markers that do not point at restored edit files', () => {
    const payload = buildWorkspaceSessionPayload(
      createSnapshot({
        activeFileIdByWorktree: { 'wt-1': '/tmp/demo.diff' },
        activeTabTypeByWorktree: { 'wt-1': 'editor', 'wt-2': 'terminal' }
      })
    )

    expect(payload.activeFileIdByWorktree).toEqual({})
    expect(payload.activeTabTypeByWorktree).toEqual({ 'wt-2': 'terminal' })
  })
})

const WORKTREE = 'wt-dup'
const FILE = '/tmp/dup/app.ts'

function editOpenFile(id: string, overrides: Partial<OpenFile> = {}): OpenFile {
  const base: OpenFile = {
    id,
    filePath: FILE,
    relativePath: 'app.ts',
    worktreeId: WORKTREE,
    language: 'typescript',
    mode: 'edit',
    isDirty: false,
    isPreview: false,
    runtimeEnvironmentId: null
  }
  return { ...base, ...overrides }
}

function buildEditorSession(
  openFiles: OpenFile[],
  overrides: {
    editorDrafts?: Record<string, string>
    markdownFrontmatterVisible?: Record<string, boolean>
    activeFileIdByWorktree?: Record<string, string | null>
  } = {}
) {
  const session = buildEditorSessionData(
    openFiles,
    overrides.editorDrafts ?? {},
    overrides.markdownFrontmatterVisible ?? {},
    overrides.activeFileIdByWorktree ?? {},
    {}
  )
  return {
    openFilesByWorktree: session.openFilesByWorktree ?? {},
    activeFileIdByWorktree: session.activeFileIdByWorktree ?? {},
    markdownFrontmatterVisible: session.markdownFrontmatterVisible ?? {}
  }
}

describe('buildEditorSessionData duplicate collapse', () => {
  it('writes one record for live files that share worktree, owner and path', () => {
    const session = buildEditorSession([
      editOpenFile(FILE),
      editOpenFile(`editor:a:${FILE}`),
      editOpenFile(`editor:b:${FILE}`)
    ])

    expect(session.openFilesByWorktree[WORKTREE]).toHaveLength(1)
  })

  it('keeps the dirty record and its disk baseline over a clean duplicate', () => {
    const session = buildEditorSession(
      [
        editOpenFile(FILE),
        editOpenFile(`editor:dirty:${FILE}`, {
          isDirty: true,
          lastKnownDiskSignature: 'sig-7'
        })
      ],
      { editorDrafts: { [`editor:dirty:${FILE}`]: 'unsaved text' } }
    )

    expect(session.openFilesByWorktree[WORKTREE]).toEqual([
      expect.objectContaining({
        dirtyDraftContent: 'unsaved text',
        lastKnownDiskSignature: 'sig-7'
      })
    ])
  })

  it('prefers the active file over a clean duplicate', () => {
    const session = buildEditorSession(
      [editOpenFile(FILE, { isPreview: true }), editOpenFile(`editor:b:${FILE}`)],
      { activeFileIdByWorktree: { [WORKTREE]: `editor:b:${FILE}` } }
    )

    expect(session.openFilesByWorktree[WORKTREE]).toEqual([
      expect.objectContaining({ isPreview: undefined })
    ])
    expect(session.activeFileIdByWorktree[WORKTREE]).toBe(`editor:b:${FILE}`)
  })

  it('remaps the active file id onto the record that outranked it', () => {
    const session = buildEditorSession(
      [editOpenFile(FILE, { isDirty: true }), editOpenFile(`editor:b:${FILE}`)],
      {
        editorDrafts: { [FILE]: 'unsaved text' },
        activeFileIdByWorktree: { [WORKTREE]: `editor:b:${FILE}` }
      }
    )

    expect(session.openFilesByWorktree[WORKTREE]).toHaveLength(1)
    expect(session.activeFileIdByWorktree[WORKTREE]).toBe(FILE)
  })

  it('never merges a read-only live-tail log with a writable record for the same path', () => {
    const session = buildEditorSession(
      [
        editOpenFile(FILE, { readOnly: true, liveTail: true }),
        editOpenFile(`editor:writable:${FILE}`, { isDirty: true })
      ],
      { editorDrafts: { [`editor:writable:${FILE}`]: 'unsaved text' } }
    )

    const [logRecord, writableRecord] = session.openFilesByWorktree[WORKTREE]
    expect(logRecord).toEqual(expect.objectContaining({ readOnly: true, liveTail: true }))
    expect(logRecord).not.toHaveProperty('dirtyDraftContent')
    expect(writableRecord).toEqual(expect.objectContaining({ dirtyDraftContent: 'unsaved text' }))
    expect(writableRecord).not.toHaveProperty('readOnly')
  })

  it('prefers a non-preview record over the active preview record', () => {
    const previewFirst = buildEditorSession(
      [editOpenFile(FILE, { isPreview: true }), editOpenFile(`editor:b:${FILE}`)],
      { activeFileIdByWorktree: { [WORKTREE]: FILE } }
    )
    const previewSecond = buildEditorSession(
      [editOpenFile(FILE), editOpenFile(`editor:b:${FILE}`, { isPreview: true })],
      { activeFileIdByWorktree: { [WORKTREE]: `editor:b:${FILE}` } }
    )

    expect(previewFirst.openFilesByWorktree[WORKTREE]).toEqual([
      expect.objectContaining({ isPreview: undefined })
    ])
    expect(previewSecond.openFilesByWorktree[WORKTREE]).toEqual([
      expect.objectContaining({ isPreview: undefined })
    ])
  })

  it('keeps records apart when only the runtime owner or the ssh target differs', () => {
    const session = buildEditorSession([
      editOpenFile(FILE),
      editOpenFile(`editor:env-a:${FILE}`, { runtimeEnvironmentId: 'env-a' }),
      editOpenFile(`editor:ssh:${FILE}`, { externalSshTargetId: 'ssh-target' })
    ])

    expect(session.openFilesByWorktree[WORKTREE]).toHaveLength(3)
  })

  it('keeps both records when two duplicates hold divergent unsaved drafts', () => {
    const session = buildEditorSession(
      [editOpenFile(FILE, { isDirty: true }), editOpenFile(`editor:b:${FILE}`, { isDirty: true })],
      { editorDrafts: { [FILE]: 'left text', [`editor:b:${FILE}`]: 'right text' } }
    )

    expect(session.openFilesByWorktree[WORKTREE].map((record) => record.dirtyDraftContent)).toEqual(
      ['left text', 'right text']
    )
  })

  it('carries a merged front-matter override onto the surviving record', () => {
    const session = buildEditorSession([editOpenFile(FILE), editOpenFile(`editor:b:${FILE}`)], {
      markdownFrontmatterVisible: { [`editor:b:${FILE}`]: false }
    })

    expect(session.markdownFrontmatterVisible).toEqual({ [FILE]: false })
  })

  it('merges a repeated draft into the variant it agrees with', () => {
    const ids = [FILE, `editor:b:${FILE}`, `editor:c:${FILE}`]
    const session = buildEditorSession(
      ids.map((id) => editOpenFile(id, { isDirty: true })),
      {
        editorDrafts: {
          [ids[0]]: 'left text',
          [ids[1]]: 'right text',
          [ids[2]]: 'right text'
        }
      }
    )

    expect(session.openFilesByWorktree[WORKTREE].map((record) => record.dirtyDraftContent)).toEqual(
      ['left text', 'right text']
    )
  })

  it('carries the merged duplicate disk baseline onto the equal-draft survivor', () => {
    const ids = [FILE, `editor:b:${FILE}`]
    const session = buildEditorSession(
      [
        editOpenFile(ids[0], { isDirty: true }),
        editOpenFile(ids[1], { isDirty: true, lastKnownDiskSignature: 'sig' })
      ],
      { editorDrafts: { [ids[0]]: 'same text', [ids[1]]: 'same text' } }
    )

    expect(session.openFilesByWorktree[WORKTREE]).toEqual([
      expect.objectContaining({ dirtyDraftContent: 'same text', lastKnownDiskSignature: 'sig' })
    ])
  })

  it('remaps the active file id onto the variant that absorbed it', () => {
    const ids = [FILE, `editor:b:${FILE}`, `editor:c:${FILE}`]
    const session = buildEditorSession(
      ids.map((id) => editOpenFile(id, { isDirty: true })),
      {
        editorDrafts: {
          [ids[0]]: 'left text',
          [ids[1]]: 'right text',
          [ids[2]]: 'right text'
        },
        activeFileIdByWorktree: { [WORKTREE]: ids[2] }
      }
    )

    expect(session.activeFileIdByWorktree[WORKTREE]).toBe(ids[1])
  })

  it('merges clean duplicates on both sides of a drafted record', () => {
    const ids = [FILE, `editor:b:${FILE}`, `editor:c:${FILE}`]
    const session = buildEditorSession(
      [editOpenFile(ids[0]), editOpenFile(ids[1], { isDirty: true }), editOpenFile(ids[2])],
      { editorDrafts: { [ids[1]]: 'right text' } }
    )

    expect(session.openFilesByWorktree[WORKTREE].map((record) => record.dirtyDraftContent)).toEqual(
      ['right text']
    )
  })

  it('keeps two records when a draft repeats after a divergent one', () => {
    const ids = [FILE, `editor:b:${FILE}`, `editor:c:${FILE}`]
    const session = buildEditorSession(
      ids.map((id) => editOpenFile(id, { isDirty: true })),
      {
        editorDrafts: {
          [ids[0]]: 'left text',
          [ids[1]]: 'right text',
          [ids[2]]: 'left text'
        }
      }
    )

    expect(session.openFilesByWorktree[WORKTREE].map((record) => record.dirtyDraftContent)).toEqual(
      ['left text', 'right text']
    )
  })
})
