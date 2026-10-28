/** Same repo/path IDs can belong to two hosts; removing remote copy must preserve local shells, tabs and dirty drafts. */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { registerPendingEditorFlush } from '@/components/editor/editor-pending-flush'
import { confirmUnsavedDiscard } from './worktrees/teardown/removed-workspace-unsaved-files'
import {
  createTestStore,
  makeOpenFile,
  makeTab,
  makeTabGroup,
  makeUnifiedTab,
  makeWorktree
} from './store-test-helpers'
import type { Repo } from '../../../../shared/repo-types'
import {
  createCompatibleRuntimeStatusResponseIfNeeded,
  type RuntimeEnvironmentCallRequest
} from '../../runtime/runtime-compatibility-test-fixture'
import { clearRuntimeCompatibilityCacheForTests } from '../../runtime/runtime-rpc-client'
import { layoutApplyTestTransport } from '@/runtime/layout-apply-test-transport.test-fixture'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../shared/layout-owner-switch'

vi.mock('@/runtime/runtime-rpc-client', async (importOriginal) =>
  (
    await import('@/runtime/layout-apply-test-transport.test-fixture')
  ).runtimeRpcClientWithLayoutApply(await importOriginal())
)
vi.mock('@/runtime/runtime-layout-client', async (importOriginal) =>
  (
    await import('@/runtime/layout-apply-test-transport.test-fixture')
  ).runtimeLayoutClientWithTestFrames(await importOriginal())
)
import { toRemoteRuntimePtyId } from '../../../../shared/remote-runtime/remote-runtime-pty-id'
import type { BrowserWorkspace } from '../../../../shared/browser-workspace-types'
import type { Tab } from '../../../../shared/tab-types'
import type { ClosedEditorTabSnapshot } from './editor/types/open-file'
import type { SleepingAgentSessionRecord } from '../../../../shared/agent-session-resume'
import { toAppSshPtyId } from '../../../../shared/ssh-pty-id'
import { worktreeWorkspaceKey } from '../../../../shared/workspace-scope'
import {
  readNativeChatComposerDraft,
  updateNativeChatComposerDraft
} from '@/components/native-chat/native-chat-composer-draft-store'

const recoveryNotice = vi.hoisted(() => vi.fn())
vi.mock('@/components/editor/closed-unsaved-files-toast', () => ({
  showClosedUnsavedFilesToast: recoveryNotice
}))

const PROJECT_ID = 'same-repo'
const WORKTREE_ID = 'same-repo::/work/same'
const REMOTE_HOST = 'runtime:env-b' as const
const LOCAL_HOST = 'local'
const localRow: Repo = {
  id: PROJECT_ID,
  path: '/work/same',
  displayName: 'Same',
  badgeColor: '#000',
  addedAt: 1,
  executionHostId: 'local'
}
const remoteRow: Repo = { ...localRow, executionHostId: REMOTE_HOST }
const remotePtyId = toRemoteRuntimePtyId('handle-1', 'env-b')

const ptyKill = vi.fn()
let onRepoRemoved: (() => void) | null = null

function browserWorkspace(id: string): BrowserWorkspace {
  return {
    id,
    worktreeId: WORKTREE_ID,
    url: 'about:blank',
    title: id,
    loading: false,
    faviconUrl: null,
    canGoBack: false,
    canGoForward: false,
    loadError: null,
    createdAt: 1
  }
}

function answerLikeRuntimeHost(args: RuntimeEnvironmentCallRequest): unknown {
  const compatible = createCompatibleRuntimeStatusResponseIfNeeded(args)
  if (compatible) {
    return compatible
  }
  if (args.method === 'repo.rm') {
    onRepoRemoved?.()
  }
  return { id: args.method, ok: true, result: {}, _meta: { runtimeId: 'runtime-remote' } }
}

beforeEach(() => {
  clearRuntimeCompatibilityCacheForTests()
  // Main routes twin editor close to its owner, then window cleans its drawn copy.
  layoutApplyTestTransport.reset()
  layoutApplyTestTransport.answerWith({ refuse: 'host_not_owned' })
  ptyKill.mockReset()
  recoveryNotice.mockClear()
  onRepoRemoved = null
  vi.stubGlobal('window', {
    api: {
      repos: {
        remove: vi.fn(),
        removeForHost: vi.fn(async ({ hostId }: { hostId: string }) => {
          if (hostId === LOCAL_HOST) {
            onRepoRemoved?.()
          }
        })
      },
      pty: { kill: ptyKill },
      runtimeEnvironments: {
        call: vi.fn(answerLikeRuntimeHost),
        list: vi.fn().mockResolvedValue([{ id: 'env-b' }])
      },
      ui: { set: vi.fn().mockResolvedValue(undefined) }
    }
  })
})

function closedSnapshot(filePath: string): ClosedEditorTabSnapshot {
  const {
    id: _id,
    isDirty: _dirty,
    ...snapshot
  } = makeOpenFile({
    id: filePath,
    worktreeId: WORKTREE_ID
  })
  return snapshot
}

function sleepingRecord(paneKey: string, connectionId: string | null): SleepingAgentSessionRecord {
  return {
    paneKey,
    worktreeId: WORKTREE_ID,
    agent: 'claude',
    providerSession: { key: 'session_id', id: paneKey },
    prompt: '',
    state: 'done',
    capturedAt: 1,
    updatedAt: 1,
    connectionId
  }
}

function seedTwins(): ReturnType<typeof createTestStore> {
  const store = createTestStore()
  const localFileId = '/work/same/local.ts'
  const remoteFileId = 'editor:remote-file'
  store.setState({
    repos: [localRow, remoteRow],
    worktreesByRepo: {
      [PROJECT_ID]: [
        makeWorktree({ id: WORKTREE_ID, repoId: PROJECT_ID, hostId: 'local' }),
        makeWorktree({ id: WORKTREE_ID, repoId: PROJECT_ID, hostId: REMOTE_HOST })
      ]
    },
    tabsByWorktree: {
      [WORKTREE_ID]: [
        makeTab({ id: 'tab-local', worktreeId: WORKTREE_ID, ptyId: 'pty-local' }),
        makeTab({ id: 'tab-remote', worktreeId: WORKTREE_ID, ptyId: remotePtyId })
      ]
    },
    ptyIdsByTabId: { 'tab-local': ['pty-local'], 'tab-remote': [remotePtyId] },
    unifiedTabsByWorktree: {
      [WORKTREE_ID]: [
        makeUnifiedTab({
          id: 'tab-local',
          worktreeId: WORKTREE_ID,
          groupId: 'group-1',
          executionHostId: 'local'
        }),
        makeUnifiedTab({
          id: 'tab-remote',
          worktreeId: WORKTREE_ID,
          groupId: 'group-1',
          executionHostId: REMOTE_HOST
        }),
        makeUnifiedTab({
          id: localFileId,
          worktreeId: WORKTREE_ID,
          groupId: 'group-1',
          contentType: 'editor',
          executionHostId: 'local'
        }),
        // Stamped with the focused twin, but the file itself names the remote host.
        makeUnifiedTab({
          id: remoteFileId,
          worktreeId: WORKTREE_ID,
          groupId: 'group-1',
          contentType: 'editor',
          executionHostId: 'local'
        })
      ]
    },
    groupsByWorktree: {
      [WORKTREE_ID]: [
        makeTabGroup({
          id: 'group-1',
          worktreeId: WORKTREE_ID,
          activeTabId: 'tab-local',
          tabOrder: ['tab-local', 'tab-remote', localFileId, remoteFileId]
        })
      ]
    },
    openFiles: [
      makeOpenFile({ id: localFileId, worktreeId: WORKTREE_ID, isDirty: true }),
      makeOpenFile({
        id: remoteFileId,
        filePath: '/work/same/remote.ts',
        worktreeId: WORKTREE_ID,
        runtimeEnvironmentId: 'env-b',
        isDirty: true
      })
    ],
    editorDrafts: { [localFileId]: 'unsaved local edit', [remoteFileId]: 'unsaved remote edit' },
    recentlyClosedEditorTabsByWorktree: {
      [WORKTREE_ID]: [
        { ...closedSnapshot('/work/same/old-remote.ts'), runtimeEnvironmentId: 'env-b' },
        closedSnapshot('/work/same/old-local.ts')
      ]
    },
    recentlyClosedTabKindsByWorktree: { [WORKTREE_ID]: ['editor', 'browser', 'editor'] }
  })
  return store
}

describe('removing a remote project keeps its local twin', () => {
  it.each([false, true])(
    'captures twin and exclusive delayed text in one notice (confirmed=%s)',
    async (confirmed) => {
      const store = seedTwins()
      const exclusive = `${PROJECT_ID}::/work/exclusive`
      const exclusiveFile = '/work/exclusive/note.ts'
      store.setState((s) => ({
        worktreesByRepo: {
          [PROJECT_ID]: [
            ...(s.worktreesByRepo[PROJECT_ID] ?? []),
            makeWorktree({ id: exclusive, repoId: PROJECT_ID, hostId: REMOTE_HOST })
          ]
        },
        openFiles: [
          ...s.openFiles,
          makeOpenFile({ id: exclusiveFile, worktreeId: exclusive, runtimeEnvironmentId: 'env-b' })
        ]
      }))
      const flushed: string[] = []
      const unregister = ['editor:remote-file', exclusiveFile].map((id) =>
        registerPendingEditorFlush(id, () => {
          flushed.push(id)
          store.setState((s) => ({ editorDrafts: { ...s.editorDrafts, [id]: `late ${id}` } }))
        })
      )
      try {
        const confirmedDiscards = confirmed
          ? confirmUnsavedDiscard(store.getState, [
              { id: WORKTREE_ID, hostId: REMOTE_HOST },
              { id: exclusive, hostId: REMOTE_HOST }
            ])
          : undefined
        await store.getState().removeProject(PROJECT_ID, { hostId: REMOTE_HOST, confirmedDiscards })
        await layoutApplyTestTransport.settle()
        expect([...new Set(flushed)].sort()).toEqual(['editor:remote-file', exclusiveFile].sort())
        expect(store.getState().editorDrafts['/work/same/local.ts']).toBe('unsaved local edit')
        if (confirmed) {
          await new Promise((resolve) => setTimeout(resolve, 0))
          expect(recoveryNotice).not.toHaveBeenCalled()
        } else {
          await vi.waitFor(() => expect(recoveryNotice).toHaveBeenCalledTimes(1))
          expect(
            recoveryNotice.mock.calls[0]?.[0].map((f: { content: string }) => f.content).sort()
          ).toEqual(['late editor:remote-file', `late ${exclusiveFile}`].sort())
        }
      } finally {
        unregister.forEach((f) => f())
      }
    }
  )

  it('keeps the local shell, tab, dirty document and draft', async () => {
    const store = seedTwins()
    updateNativeChatComposerDraft('tab-local:leaf-1', { text: 'local chat draft' }, 'deferred')

    await store.getState().removeProject(PROJECT_ID, { hostId: REMOTE_HOST })
    await layoutApplyTestTransport.settle()

    const state = store.getState()
    // A layout-owner build asks main to close the removed host's editor tab first.
    if (ORCA_LAYOUT_OWNER_IS_MAIN) {
      expect(layoutApplyTestTransport.sentOfType('closeTabs')).toEqual([
        { type: 'closeTabs', workspace: WORKTREE_ID, tabIds: ['editor:remote-file'] }
      ])
    }
    expect(state.repos).toEqual([localRow])
    expect(ptyKill).not.toHaveBeenCalledWith('pty-local')
    expect(state.tabsByWorktree[WORKTREE_ID]?.map((tab) => tab.id)).toEqual(['tab-local'])
    expect(state.ptyIdsByTabId['tab-local']).toEqual(['pty-local'])
    expect(state.unifiedTabsByWorktree[WORKTREE_ID]?.map((tab) => tab.id)).toEqual([
      'tab-local',
      '/work/same/local.ts'
    ])
    expect(state.openFiles.map((file) => file.id)).toEqual(['/work/same/local.ts'])
    expect(state.editorDrafts).toEqual({ '/work/same/local.ts': 'unsaved local edit' })
    expect(readNativeChatComposerDraft('tab-local:leaf-1').text).toBe('local chat draft')
    // Shared reopen history is left whole: a stale entry, never a lost one of the survivor's.
    expect(
      state.recentlyClosedEditorTabsByWorktree[WORKTREE_ID]?.map((snapshot) => snapshot.filePath)
    ).toContain('/work/same/old-local.ts')
  })

  it('closes the removed host’s browsers, chats and hydrated terminals, and tabs opened meanwhile', async () => {
    const store = seedTwins()
    const unified = (overrides: Partial<Tab> & { id: string }): Tab =>
      makeUnifiedTab({ worktreeId: WORKTREE_ID, groupId: 'group-1', ...overrides })
    const closedBrowser = (id: string, browserRuntimeEnvironmentId: string | null) => ({
      workspace: browserWorkspace(id),
      pages: [{ ...browserWorkspace(id), workspaceId: id, browserRuntimeEnvironmentId }]
    })
    store.setState((s) => ({
      recentlyClosedBrowserTabsByWorktree: {
        [WORKTREE_ID]: [
          closedBrowser('closed-remote', 'env-b'),
          closedBrowser('closed-local', null)
        ]
      },
      recentlyClosedTabKindsByWorktree: { [WORKTREE_ID]: ['browser', 'browser'] },
      browserTabsByWorktree: {
        [WORKTREE_ID]: [
          browserWorkspace('browser-local'),
          browserWorkspace('browser-remote'),
          browserWorkspace('browser-remote-unstamped')
        ]
      },
      browserPagesByWorkspace: {
        'browser-remote-unstamped': closedBrowser('browser-remote-unstamped', 'env-b').pages
      },
      unifiedTabsByWorktree: {
        [WORKTREE_ID]: [
          ...(s.unifiedTabsByWorktree[WORKTREE_ID] ?? []),
          unified({ id: 'browser-local', contentType: 'browser', executionHostId: 'local' }),
          unified({ id: 'browser-remote', contentType: 'browser', executionHostId: REMOTE_HOST }),
          unified({ id: 'browser-remote-unstamped', contentType: 'browser' }),
          unified({
            id: 'chat-remote',
            contentType: 'agent-session',
            executionHostId: REMOTE_HOST
          }),
          unified({ id: 'hydrated-remote', executionHostId: REMOTE_HOST }),
          unified({ id: 'sim-remote', contentType: 'simulator', executionHostId: REMOTE_HOST })
        ]
      }
    }))
    // Opened while the host call was pending, so the pre-call snapshot cannot see it.
    onRepoRemoved = () =>
      store.setState((s) => ({
        unifiedTabsByWorktree: {
          [WORKTREE_ID]: [
            ...(s.unifiedTabsByWorktree[WORKTREE_ID] ?? []),
            unified({ id: 'late-remote', executionHostId: REMOTE_HOST })
          ]
        }
      }))

    await store.getState().removeProject(PROJECT_ID, { hostId: REMOTE_HOST })
    await layoutApplyTestTransport.settle()

    const state = store.getState()
    expect(state.browserTabsByWorktree[WORKTREE_ID]?.map((tab) => tab.id)).toEqual([
      'browser-local'
    ])
    expect(state.unifiedTabsByWorktree[WORKTREE_ID]?.map((tab) => tab.id)).toEqual([
      'tab-local',
      '/work/same/local.ts',
      'browser-local'
    ])
    expect(
      state.recentlyClosedBrowserTabsByWorktree[WORKTREE_ID]?.map((entry) => entry.workspace.id)
    ).toContain('closed-local')
  })

  it('attributes unstamped terminals by the host their PTY ids name, wherever those are kept', async () => {
    const store = createTestStore()
    const sshRow: Repo = { ...localRow, connectionId: 'target-1', executionHostId: 'ssh:target-1' }
    const sshPtyId = toAppSshPtyId('target-1', 'relay-1')
    store.setState({
      repos: [localRow, sshRow, remoteRow],
      worktreesByRepo: {
        [PROJECT_ID]: [
          makeWorktree({ id: WORKTREE_ID, repoId: PROJECT_ID, hostId: 'local' }),
          makeWorktree({
            id: WORKTREE_ID,
            repoId: PROJECT_ID,
            hostId: 'ssh:target-1',
            runtimeOwnerEnvironmentId: 'env-b'
          })
        ]
      },
      tabsByWorktree: {
        [WORKTREE_ID]: [
          makeTab({ id: 'tab-local', worktreeId: WORKTREE_ID, ptyId: 'pty-local' }),
          makeTab({ id: 'tab-ssh', worktreeId: WORKTREE_ID, ptyId: sshPtyId }),
          // Restored: the only record of its host is the layout's pane binding.
          makeTab({ id: 'tab-ssh-restored', worktreeId: WORKTREE_ID }),
          // Mirrored through the paired runtime that reaches this SSH copy.
          makeTab({ id: 'tab-ssh-mirrored', worktreeId: WORKTREE_ID, ptyId: remotePtyId })
        ]
      },
      unifiedTabsByWorktree: {
        [WORKTREE_ID]: [
          makeUnifiedTab({
            id: 'tab-ssh-mirrored',
            worktreeId: WORKTREE_ID,
            groupId: 'group-1',
            executionHostId: REMOTE_HOST
          })
        ]
      },
      ptyIdsByTabId: {
        'tab-local': ['pty-local'],
        'tab-ssh': [sshPtyId],
        'tab-ssh-mirrored': [remotePtyId]
      },
      // Selected through the paired runtime that reaches the SSH copy.
      activeWorktreeId: WORKTREE_ID,
      activeWorkspaceExecutionHostId: REMOTE_HOST,
      recentlyClosedEditorTabsByWorktree: {
        [WORKTREE_ID]: [
          { ...closedSnapshot('/work/same/via-runtime.ts'), runtimeEnvironmentId: 'env-b' }
        ]
      },
      // Records whose tabs are gone.
      sleepingAgentSessionsByPaneKey: {
        'gone-ssh:leaf': sleepingRecord('gone-ssh:leaf', 'target-1'),
        'gone-local:leaf': sleepingRecord('gone-local:leaf', null)
      },
      terminalLayoutsByTabId: {
        'tab-ssh-restored': {
          root: null,
          activeLeafId: null,
          expandedLeafId: null,
          ptyIdsByLeafId: { 'leaf-1': toAppSshPtyId('target-1', 'relay-2') }
        }
      }
    })

    await store.getState().removeProject(PROJECT_ID, { hostId: 'ssh:target-1' })

    expect(ptyKill).not.toHaveBeenCalledWith('pty-local')
    expect(ptyKill).toHaveBeenCalledWith(sshPtyId)
    // A parked layout hint closes its tab but is never killed: it may name another host's session.
    expect(ptyKill).not.toHaveBeenCalledWith(toAppSshPtyId('target-1', 'relay-2'))
    expect(store.getState().activeWorkspaceExecutionHostId).not.toBe(REMOTE_HOST)
    // A tabless record names no tab the removal closes, so it stays (stale) rather than risk the survivor's.
    expect(Object.keys(store.getState().sleepingAgentSessionsByPaneKey)).toContain(
      'gone-local:leaf'
    )
    expect(store.getState().tabsByWorktree[WORKTREE_ID]?.map((tab) => tab.id)).toEqual([
      'tab-local'
    ])
  })

  it('purges the shared state when both copies are removed at once', async () => {
    const store = seedTwins()

    await Promise.all([
      store.getState().removeProject(PROJECT_ID, { hostId: REMOTE_HOST }),
      store.getState().removeProject(PROJECT_ID, { hostId: 'local' })
    ])

    const state = store.getState()
    expect(state.repos).toEqual([])
    expect(state.tabsByWorktree[WORKTREE_ID] ?? []).toEqual([])
    expect(state.unifiedTabsByWorktree[WORKTREE_ID] ?? []).toEqual([])
    expect(state.openFiles).toEqual([])
  })

  it('keeps a PTY that a tab outside the removal still binds', async () => {
    const store = createTestStore()
    const sshRow: Repo = { ...localRow, connectionId: 'target-1', executionHostId: 'ssh:target-1' }
    const sharedPtyId = toAppSshPtyId('target-1', 'relay-shared')
    const otherWorktreeId = 'other-repo::/work/other'
    store.setState({
      repos: [localRow, sshRow],
      worktreesByRepo: {
        [PROJECT_ID]: [
          makeWorktree({ id: WORKTREE_ID, repoId: PROJECT_ID, hostId: 'local' }),
          makeWorktree({ id: WORKTREE_ID, repoId: PROJECT_ID, hostId: 'ssh:target-1' })
        ]
      },
      tabsByWorktree: {
        [WORKTREE_ID]: [makeTab({ id: 'tab-ssh', worktreeId: WORKTREE_ID, ptyId: sharedPtyId })],
        [otherWorktreeId]: [
          makeTab({ id: 'tab-other', worktreeId: otherWorktreeId, ptyId: sharedPtyId })
        ]
      },
      ptyIdsByTabId: { 'tab-ssh': [sharedPtyId], 'tab-other': [sharedPtyId] }
    })

    await store.getState().removeProject(PROJECT_ID, { hostId: 'ssh:target-1' })

    expect(ptyKill).not.toHaveBeenCalledWith(sharedPtyId)
    expect(store.getState().tabsByWorktree[otherWorktreeId]?.map((tab) => tab.id)).toEqual([
      'tab-other'
    ])
  })

  it('removing the local copy closes its stale editor tabs and stops the local pane in a mixed tab', async () => {
    const store = seedTwins()
    const closedBrowser = (id: string, browserRuntimeEnvironmentId: string | null) => ({
      workspace: browserWorkspace(id),
      pages: [{ ...browserWorkspace(id), workspaceId: id, browserRuntimeEnvironmentId }]
    })
    store.setState((s) => ({
      // Stamped local, but one pane runs on the surviving runtime: it is not only local's.
      tabsByWorktree: {
        [WORKTREE_ID]: [
          ...(s.tabsByWorktree[WORKTREE_ID] ?? []),
          makeTab({ id: 'tab-mixed', worktreeId: WORKTREE_ID, ptyId: 'pty-mixed-local' }),
          // A legacy remote pane names no owner, so the local stamp cannot claim it.
          makeTab({ id: 'tab-foreign', worktreeId: WORKTREE_ID, ptyId: 'remote:legacy-handle' })
        ]
      },
      ptyIdsByTabId: {
        ...s.ptyIdsByTabId,
        'tab-mixed': ['pty-mixed-local', remotePtyId],
        'tab-foreign': ['remote:legacy-handle']
      },
      recentlyClosedBrowserTabsByWorktree: {
        [WORKTREE_ID]: [
          closedBrowser('closed-local', null),
          closedBrowser('closed-remote', 'env-b')
        ]
      },
      unifiedTabsByWorktree: {
        [WORKTREE_ID]: [
          ...(s.unifiedTabsByWorktree[WORKTREE_ID] ?? []),
          makeUnifiedTab({
            id: 'tab-mixed',
            worktreeId: WORKTREE_ID,
            groupId: 'group-1',
            executionHostId: 'local'
          }),
          makeUnifiedTab({
            id: 'tab-foreign',
            worktreeId: WORKTREE_ID,
            groupId: 'group-1',
            executionHostId: 'local'
          }),
          makeUnifiedTab({
            id: 'stale-editor',
            worktreeId: WORKTREE_ID,
            groupId: 'group-1',
            contentType: 'editor',
            executionHostId: 'local'
          })
        ]
      }
    }))

    await store.getState().removeProject(PROJECT_ID, { hostId: 'local' })
    await layoutApplyTestTransport.settle()

    const state = store.getState()
    expect(
      state.recentlyClosedBrowserTabsByWorktree[WORKTREE_ID]?.map((entry) => entry.workspace.id)
    ).toContain('closed-remote')
    expect(state.unifiedTabsByWorktree[WORKTREE_ID]?.map((tab) => tab.id)).toEqual([
      'tab-remote',
      'editor:remote-file',
      'tab-mixed',
      'tab-foreign'
    ])
    expect(ptyKill).not.toHaveBeenCalledWith(remotePtyId)
    // The mixed tab stays for its runtime pane, but the removed local pane's shell is stopped.
    expect(ptyKill).toHaveBeenCalledWith('pty-mixed-local')
    expect(
      state.recentlyClosedEditorTabsByWorktree[WORKTREE_ID]?.map((snapshot) => snapshot.filePath)
    ).toContain('/work/same/old-remote.ts')
  })

  it('leaves no selection naming the removed host after its last editor closes', async () => {
    const store = createTestStore()
    store.setState({
      repos: [localRow, remoteRow],
      worktreesByRepo: {
        [PROJECT_ID]: [
          makeWorktree({ id: WORKTREE_ID, repoId: PROJECT_ID, hostId: 'local' }),
          makeWorktree({ id: WORKTREE_ID, repoId: PROJECT_ID, hostId: REMOTE_HOST })
        ]
      },
      openFiles: [
        makeOpenFile({
          id: 'editor:remote-only',
          worktreeId: WORKTREE_ID,
          runtimeEnvironmentId: 'env-b'
        })
      ],
      activeFileId: 'editor:remote-only',
      activeWorktreeId: WORKTREE_ID,
      activeWorkspaceKey: worktreeWorkspaceKey(WORKTREE_ID),
      activeWorkspaceExecutionHostId: REMOTE_HOST
    })

    await store.getState().removeProject(PROJECT_ID, { hostId: REMOTE_HOST })

    const state = store.getState()
    expect(state.activeWorkspaceExecutionHostId).not.toBe(REMOTE_HOST)
    if (state.activeWorktreeId === null) {
      expect(state.activeWorkspaceKey).toBeNull()
    }
  })

  it('leaves the focused workspace’s active surface alone when a background twin is removed', async () => {
    const store = seedTwins()
    store.setState({
      activeWorktreeId: 'other-repo::/work/other',
      activeTabType: 'agent-session',
      activeTabTypeByWorktree: { 'other-repo::/work/other': 'agent-session' }
    })

    await store.getState().removeProject(PROJECT_ID, { hostId: REMOTE_HOST })

    expect(store.getState().activeTabType).toBe('agent-session')
    expect(store.getState().activeTabTypeByWorktree['other-repo::/work/other']).toBe(
      'agent-session'
    )
  })

  it('keeps a tab that gained a surviving pane during removal and stops its removed pane', async () => {
    const store = seedTwins()
    store.setState((s) => ({
      unifiedTabsByWorktree: {
        [WORKTREE_ID]: (s.unifiedTabsByWorktree[WORKTREE_ID] ?? []).filter(
          (tab) => tab.id !== 'tab-remote'
        )
      },
      tabsByWorktree: {
        [WORKTREE_ID]: (s.tabsByWorktree[WORKTREE_ID] ?? []).filter(
          (tab) => tab.id !== 'tab-remote'
        )
      }
    }))
    onRepoRemoved = () =>
      store.setState((s) => ({
        ptyIdsByTabId: { ...s.ptyIdsByTabId, 'tab-local': ['pty-local', remotePtyId] }
      }))

    await store.getState().removeProject(PROJECT_ID, { hostId: 'local' })

    expect(store.getState().tabsByWorktree[WORKTREE_ID]?.map((tab) => tab.id)).toEqual([
      'tab-local'
    ])
    expect(ptyKill).toHaveBeenCalledWith('pty-local')
    expect(ptyKill).not.toHaveBeenCalledWith(remotePtyId)
  })

  it('still retires a removed-host tab a host frame dropped during the call', async () => {
    const store = seedTwins()
    const agentStatus = (paneKey: string) => ({
      state: 'working' as const,
      prompt: '',
      updatedAt: 1,
      stateStartedAt: 1,
      paneKey,
      stateHistory: [],
      agentType: 'claude' as const
    })
    store.setState({
      agentStatusByPaneKey: {
        'tab-local:leaf': agentStatus('tab-local:leaf'),
        'tab-remote:leaf': agentStatus('tab-remote:leaf')
      }
    })
    // Like a snapshot reducer: the tab goes, its agent rows stay.
    onRepoRemoved = () =>
      store.setState((s) => ({
        tabsByWorktree: {
          [WORKTREE_ID]: (s.tabsByWorktree[WORKTREE_ID] ?? []).filter(
            (tab) => tab.id !== 'tab-remote'
          )
        },
        unifiedTabsByWorktree: {
          [WORKTREE_ID]: (s.unifiedTabsByWorktree[WORKTREE_ID] ?? []).filter(
            (tab) => tab.id !== 'tab-remote'
          )
        }
      }))

    await store.getState().removeProject(PROJECT_ID, { hostId: REMOTE_HOST })

    expect(Object.keys(store.getState().agentStatusByPaneKey)).toEqual(['tab-local:leaf'])
  })

  it('retires a dropped removed-host tab when the other copy also went during the call', async () => {
    const store = seedTwins()
    // The other copy's removal and a host frame both land while this call is pending.
    onRepoRemoved = () =>
      store.setState((s) => ({
        worktreesByRepo: {
          [PROJECT_ID]: (s.worktreesByRepo[PROJECT_ID] ?? []).filter(
            (row) => row.hostId !== LOCAL_HOST
          )
        },
        tabsByWorktree: {
          [WORKTREE_ID]: (s.tabsByWorktree[WORKTREE_ID] ?? []).filter(
            (tab) => tab.id !== 'tab-remote'
          )
        },
        unifiedTabsByWorktree: {
          [WORKTREE_ID]: (s.unifiedTabsByWorktree[WORKTREE_ID] ?? []).filter(
            (tab) => tab.id !== 'tab-remote'
          )
        }
      }))

    await store.getState().removeProject(PROJECT_ID, { hostId: REMOTE_HOST })

    expect(store.getState().ptyIdsByTabId['tab-remote']).toBeUndefined()
  })

  it('leaves the selection unchanged on a single-host removal', async () => {
    const store = createTestStore()
    const otherKey = worktreeWorkspaceKey('other-repo::/work/other')
    const otherRepo: Repo = { ...localRow, id: 'other-repo', path: '/work/other' }
    store.setState({
      repos: [remoteRow, otherRepo],
      worktreesByRepo: {
        [PROJECT_ID]: [makeWorktree({ id: WORKTREE_ID, repoId: PROJECT_ID, hostId: REMOTE_HOST })]
      },
      activeWorktreeId: null,
      activeWorkspaceKey: otherKey,
      activeWorkspaceExecutionHostId: REMOTE_HOST
    })

    await store.getState().removeProject(PROJECT_ID, { hostId: REMOTE_HOST })

    const state = store.getState()
    expect(state.activeWorkspaceKey).toBe(otherKey)
    expect(state.activeWorkspaceExecutionHostId).toBe(REMOTE_HOST)
  })
})
