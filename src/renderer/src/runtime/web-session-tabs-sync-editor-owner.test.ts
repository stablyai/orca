import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ExecutionHostId } from '../../../shared/execution-host'
import type * as WebRuntimeSession from './web-runtime-session'
import type { OpenFile } from '../store/slices/editor'
import { buildEditorSessionData } from '../lib/workspace-session'
import { createTestStore, makeWorktree } from '../store/slices/store-test-helpers'
import { createStoreSessionMockApi } from '../store/slices/store-session-test-harness'
import { applyWebSessionTabsSnapshot } from './web-session-tabs-sync'
import { notifyHostOfMirroredEditorClose } from './close-mirrored-editor-tab'
import { isWebSessionCloseIntentPending } from './web-session-close-intent'
import { clearHostSessionTabIdMappings } from './web-session-tabs-sync/tracking-mappings'
import {
  ENV,
  NOW,
  WT,
  makeSnapshot,
  resetWebSessionTabsSyncTestState
} from './web-session-tabs-sync-test-harness'

vi.mock('sonner', () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }))
const closeTab = vi.hoisted(() =>
  vi.fn<typeof WebRuntimeSession.closeWebRuntimeSessionTab>().mockResolvedValue('applied')
)
vi.mock('./web-runtime-session', () => ({ closeWebRuntimeSessionTab: closeTab }))

createStoreSessionMockApi()

const filePath = '/repo/notes.md'
const draft = '# client draft'

function ownerStore(executionHostId: ExecutionHostId) {
  const store = createTestStore()
  store.setState({
    activeWorktreeId: WT,
    repos: [
      {
        id: 'repo',
        path: '/repo',
        displayName: 'Repo',
        badgeColor: '#000',
        addedAt: 0,
        executionHostId
      }
    ],
    worktreesByRepo: {
      repo: [makeWorktree({ id: WT, repoId: 'repo', path: '/repo', hostId: executionHostId })]
    }
  })
  return store
}

function snapshot(snapshotVersion: number, tabId = 'host-notes') {
  return makeSnapshot(
    [
      {
        type: 'markdown',
        id: tabId,
        title: 'notes.md',
        filePath,
        relativePath: 'notes.md',
        language: 'markdown',
        mode: 'edit',
        isDirty: false,
        isActive: true,
        sourceFileId: filePath,
        sourceFilePath: filePath,
        sourceRelativePath: 'notes.md',
        documentVersion: 'disk'
      }
    ],
    { snapshotVersion, activeTabId: tabId, activeTabType: 'markdown' }
  )
}

function file(runtimeEnvironmentId: string | null): OpenFile {
  return {
    id: filePath,
    filePath,
    relativePath: 'notes.md',
    worktreeId: WT,
    language: 'markdown',
    isDirty: true,
    mode: 'edit',
    runtimeEnvironmentId
  }
}

describe('mirrored editor ownership and restored drafts', () => {
  beforeEach(() => {
    resetWebSessionTabsSyncTestState()
    closeTab.mockClear()
  })

  it.each([false, true])('retains a local raw-path row when client dirty is %s', (isDirty) => {
    const store = ownerStore('local')
    store.setState({
      activeWorkspaceExecutionHostId: 'runtime:unrelated',
      openFiles: [{ ...file(null), isDirty }],
      editorDrafts: isDirty ? { [filePath]: draft } : {}
    })

    store.setState(applyWebSessionTabsSnapshot(store.getState(), snapshot(1), ENV, NOW))

    expect(store.getState().openFiles).toEqual([
      expect.objectContaining({ id: filePath, runtimeEnvironmentId: null, isDirty })
    ])
    expect(store.getState().editorDrafts[filePath]).toBe(isDirty ? draft : undefined)
  })

  it('keeps one remote file and its draft through repeated restore and live updates', () => {
    const store = ownerStore(`runtime:${ENV}`)
    store.setState(applyWebSessionTabsSnapshot(store.getState(), snapshot(1), ENV, NOW))
    store.setState({
      openFiles: store.getState().openFiles.map((entry) => ({ ...entry, isDirty: true })),
      editorDrafts: { [filePath]: draft }
    })

    for (let cycle = 1; cycle <= 3; cycle++) {
      const state = store.getState()
      const persisted = buildEditorSessionData(
        state.openFiles,
        state.editorDrafts,
        state.markdownFrontmatterVisible,
        state.activeFileIdByWorktree,
        state.activeTabTypeByWorktree
      )
      state.hydrateEditorSession({
        activeRepoId: 'repo',
        activeWorktreeId: WT,
        activeTabId: null,
        tabsByWorktree: {},
        terminalLayoutsByTabId: {},
        ...persisted
      })
      store.setState(
        applyWebSessionTabsSnapshot(store.getState(), snapshot(cycle + 1), ENV, NOW + cycle)
      )

      expect(store.getState().openFiles).toHaveLength(1)
      const restored = store.getState().openFiles[0]
      expect(restored.isDirty).toBe(true)
      expect(store.getState().editorDrafts[restored.id]).toBe(draft)
    }
  })

  it('retains a client-dirty mirrored file when the publisher omits it', () => {
    const store = ownerStore(`runtime:${ENV}`)
    store.setState(applyWebSessionTabsSnapshot(store.getState(), snapshot(1), ENV, NOW))
    store.getState().setEditorDraft(filePath, draft)
    store.getState().markFileDirty(filePath, true)

    store.setState(
      applyWebSessionTabsSnapshot(
        store.getState(),
        makeSnapshot([], { snapshotVersion: 1 }),
        ENV,
        NOW
      )
    )

    expect(store.getState().openFiles).toEqual([expect.objectContaining({ id: filePath })])
    expect(store.getState().editorDrafts[filePath]).toBe(draft)
  })

  it('uses the publisher owner when the local catalog has no workspace record', () => {
    const store = createTestStore()
    store.setState(applyWebSessionTabsSnapshot(store.getState(), snapshot(1), ENV, NOW))

    expect(store.getState().openFiles).toEqual([
      expect.objectContaining({ runtimeEnvironmentId: ENV })
    ])
  })

  it.each(['local', `runtime:${ENV}`] as const)('uses the %s folder owner', (executionHostId) => {
    const store = createTestStore()
    store.setState({
      projectGroups: [
        {
          id: 'folder-group',
          name: 'Folder',
          parentPath: '/repo',
          parentGroupId: null,
          createdFrom: 'manual',
          tabOrder: 0,
          isCollapsed: false,
          color: null,
          createdAt: 0,
          updatedAt: 0,
          executionHostId
        }
      ],
      folderWorkspaces: [
        {
          id: 'folder',
          projectGroupId: 'folder-group',
          name: 'Folder',
          folderPath: '/repo',
          linkedTask: null,
          comment: '',
          isArchived: false,
          isUnread: false,
          isPinned: false,
          sortOrder: 0,
          lastActivityAt: 0,
          createdAt: 0,
          updatedAt: 0
        }
      ]
    })

    store.setState(
      applyWebSessionTabsSnapshot(
        store.getState(),
        { ...snapshot(1), worktree: 'folder:folder' },
        ENV,
        NOW
      )
    )

    expect(store.getState().openFiles).toEqual([
      expect.objectContaining({
        worktreeId: 'folder:folder',
        runtimeEnvironmentId: executionHostId === 'local' ? null : ENV
      })
    ])
  })

  it('retains the target owner draft when legacy rows share the same raw id', () => {
    const store = createTestStore()
    const otherOwner = { ...file('other'), isDirty: false, mirroredFromRuntimeSession: true }
    const targetOwner = { ...file(ENV), mirroredFromRuntimeSession: true }
    store.setState({
      openFiles: [otherOwner, targetOwner],
      editorDrafts: { [filePath]: draft }
    })

    store.setState(applyWebSessionTabsSnapshot(store.getState(), snapshot(1), ENV, NOW))

    expect(store.getState().openFiles).toEqual([
      otherOwner,
      expect.objectContaining({ id: filePath, runtimeEnvironmentId: ENV, isDirty: true })
    ])
    expect(store.getState().editorDrafts[filePath]).toBe(draft)
  })

  it('preserves an explicitly remote dirty draft beside a receiver-local mirror', () => {
    const store = ownerStore('local')
    store.setState({ openFiles: [file(ENV)], editorDrafts: { [filePath]: draft } })

    store.setState(applyWebSessionTabsSnapshot(store.getState(), snapshot(1), ENV, NOW))

    const state = store.getState()
    expect(state.openFiles).toHaveLength(2)
    expect(state.openFiles.find((entry) => entry.runtimeEnvironmentId === ENV)).toEqual(file(ENV))
    expect(state.editorDrafts[filePath]).toBe(draft)
    expect(state.openFiles.find((entry) => entry.runtimeEnvironmentId === null)?.id).not.toBe(
      filePath
    )
  })

  it('keeps different runtime publishers separate when incoming tab ids and paths match', () => {
    const store = createTestStore()
    store.setState(applyWebSessionTabsSnapshot(store.getState(), snapshot(1), ENV, NOW))
    store.getState().setEditorDraft(filePath, draft)
    store.getState().markFileDirty(filePath, true)

    store.setState(applyWebSessionTabsSnapshot(store.getState(), snapshot(1), 'other', NOW))

    const state = store.getState()
    expect(state.openFiles).toHaveLength(2)
    expect(state.openFiles.find((file) => file.runtimeEnvironmentId === ENV)?.isDirty).toBe(true)
    expect(state.editorDrafts[filePath]).toBe(draft)
    const tabs = state.unifiedTabsByWorktree[WT].filter((tab) => tab.contentType === 'editor')
    expect(tabs).toHaveLength(2)
    expect(new Set(tabs.map((tab) => tab.id)).size).toBe(2)
    expect(new Set(tabs.map((tab) => tab.entityId)).size).toBe(2)
    for (const publisher of [ENV, 'other']) {
      store.setState(applyWebSessionTabsSnapshot(store.getState(), snapshot(2), publisher, NOW))
    }
    expect(
      store
        .getState()
        .unifiedTabsByWorktree[WT].map((tab) => tab.id)
        .sort()
    ).toEqual(tabs.map((tab) => tab.id).sort())
  })

  it('retains a shared local mirror until both publishing hosts omit it', () => {
    const store = ownerStore('local')
    store.setState(applyWebSessionTabsSnapshot(store.getState(), snapshot(1), ENV, NOW))
    store.setState(
      applyWebSessionTabsSnapshot(store.getState(), snapshot(1, 'second-notes'), 'second', NOW)
    )
    expect(store.getState().openFiles).toHaveLength(1)

    store.setState(applyWebSessionTabsSnapshot(store.getState(), makeSnapshot([]), ENV, NOW))
    expect(store.getState().openFiles).toHaveLength(1)
    store.setState(applyWebSessionTabsSnapshot(store.getState(), makeSnapshot([]), 'second', NOW))
    expect(store.getState().openFiles).toHaveLength(0)
  })

  it('closes both actual publisher tabs while a different UI host is selected', async () => {
    const store = ownerStore('local')
    store.setState(applyWebSessionTabsSnapshot(store.getState(), snapshot(1), ENV, NOW))
    store.setState(
      applyWebSessionTabsSnapshot(store.getState(), snapshot(1, 'second-notes'), 'second', NOW)
    )
    store.setState({ activeWorkspaceExecutionHostId: 'runtime:unrelated' })

    expect(notifyHostOfMirroredEditorClose(store.getState(), WT, filePath)).toBe(true)
    for (const [environmentId, tabId] of [
      [ENV, 'host-notes'],
      ['second', 'second-notes']
    ]) {
      expect(isWebSessionCloseIntentPending({ environmentId }, WT, tabId, Date.now())).toBe(true)
    }
    await vi.waitFor(() => expect(closeTab).toHaveBeenCalledTimes(2))
    expect(closeTab).toHaveBeenCalledWith({
      environmentId: ENV,
      worktreeId: WT,
      tabId: 'host-notes',
      reason: 'user'
    })
    expect(closeTab).toHaveBeenCalledWith({
      environmentId: 'second',
      worktreeId: WT,
      tabId: 'second-notes',
      reason: 'user'
    })
  })

  it('keeps local close authoritative over in-flight echoes from both publishers', () => {
    const store = ownerStore('local')
    store.setState(applyWebSessionTabsSnapshot(store.getState(), snapshot(1), ENV, NOW))
    store.setState(
      applyWebSessionTabsSnapshot(store.getState(), snapshot(1, 'second-notes'), 'second', NOW)
    )
    store.getState().closeFile(filePath)
    expect(store.getState().openFiles).toHaveLength(0)

    store.setState(applyWebSessionTabsSnapshot(store.getState(), snapshot(2), ENV, Date.now()))
    store.setState(
      applyWebSessionTabsSnapshot(
        store.getState(),
        snapshot(2, 'second-notes'),
        'second',
        Date.now()
      )
    )
    expect(store.getState().openFiles).toHaveLength(0)
  })

  it('keeps local close authoritative after a publisher omits the client-dirty mirror', () => {
    const store = ownerStore('local')
    store.setState(applyWebSessionTabsSnapshot(store.getState(), snapshot(1), ENV, NOW))
    store.getState().setEditorDraft(filePath, draft)
    store.getState().markFileDirty(filePath, true)
    store.setState(applyWebSessionTabsSnapshot(store.getState(), makeSnapshot([]), ENV, NOW))
    store.getState().closeFile(filePath)

    store.setState(applyWebSessionTabsSnapshot(store.getState(), snapshot(2), ENV, Date.now()))

    expect(store.getState().openFiles).toHaveLength(0)
  })

  it('reuses the same local draft after publisher mappings are reset on reconnect', () => {
    const store = ownerStore('local')
    store.setState(applyWebSessionTabsSnapshot(store.getState(), snapshot(1), ENV, NOW))
    store.getState().setEditorDraft(filePath, draft)
    store.getState().markFileDirty(filePath, true)
    clearHostSessionTabIdMappings(ENV, WT)

    store.setState(
      applyWebSessionTabsSnapshot(store.getState(), snapshot(1, 'reconnected-notes'), ENV, NOW)
    )

    expect(store.getState().openFiles).toEqual([
      expect.objectContaining({ id: filePath, runtimeEnvironmentId: null, isDirty: true })
    ])
    expect(store.getState().editorDrafts[filePath]).toBe(draft)
  })

  it('resolves preview identity from its distinct source path and retained draft', () => {
    const store = ownerStore('local')
    store.setState({ openFiles: [file(null)], editorDrafts: { [filePath]: draft } })
    const publication = snapshot(1)
    const preview = publication.tabs.find((tab) => tab.type === 'markdown')
    if (!preview || preview.type !== 'markdown') {
      throw new Error('Expected markdown fixture')
    }
    store.setState(
      applyWebSessionTabsSnapshot(
        store.getState(),
        {
          ...publication,
          tabs: [{ ...preview, filePath: '/repo/preview.md', mode: 'markdown-preview' }]
        },
        ENV,
        NOW
      )
    )

    expect(store.getState().openFiles).toEqual(
      expect.arrayContaining([
        file(null),
        expect.objectContaining({
          id: `markdown-preview::${filePath}`,
          markdownPreviewSourceFileId: filePath,
          runtimeEnvironmentId: null
        })
      ])
    )
    expect(store.getState().editorDrafts[filePath]).toBe(draft)
  })

  it('bounds new mirrored path lookups across unrelated open files', () => {
    const store = ownerStore('local')
    let idReads = 0
    store.setState({
      openFiles: Array.from({ length: 1000 }, (_, index) => ({
        ...file(null),
        get id() {
          idReads++
          return `/unrelated/${index}`
        },
        filePath: `/unrelated/${index}`,
        worktreeId: 'unrelated'
      }))
    })
    const publication = snapshot(1)
    const source = publication.tabs.find((tab) => tab.type === 'markdown')
    if (!source || source.type !== 'markdown') {
      throw new Error('Expected markdown fixture')
    }
    const frame = {
      ...publication,
      tabs: Array.from({ length: 200 }, (_, index) => ({
        ...source,
        id: `host-${index}`,
        filePath: `/repo/new-${index}.md`,
        sourceFilePath: `/repo/new-${index}.md`
      }))
    }
    idReads = 0
    store.setState(applyWebSessionTabsSnapshot(store.getState(), frame, ENV, NOW))

    expect(store.getState().openFiles).toHaveLength(1200)
    expect(idReads).toBeLessThanOrEqual(5000)
    idReads = 0
    store.setState(
      applyWebSessionTabsSnapshot(store.getState(), { ...frame, snapshotVersion: 2 }, ENV, NOW)
    )
    expect(idReads).toBeLessThanOrEqual(2000)
  })
})
