// @vitest-environment happy-dom
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store/index'
import { worktreeWorkspaceKey } from '../../../../../../shared/workspace-scope'
import type { AppState } from '@/store/types'
import {
  drawTabsFromMain,
  type TabsDrawnFromMain
} from '../../tabs/tabs-drawn-from-main.test-fixture'
import { layoutApplyTestTransport } from '@/runtime/workspace-layout/testing/layout-apply-test-transport.test-fixture'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../../../shared/layout-owner-switch'
import { hasPendingEntityTab } from '@/runtime/workspace-layout/intents/layout-owner-pending-tabs'
import { buildMobileSessionTabSnapshots } from '@/runtime/sync-runtime-graph/mobile-session-snapshots'
import { workspaceEditorFiles } from './workspace-editor-files'
import { removeWorktreeLayout } from '../../tabs/worktree-layout-lifecycle'
import { buildHydratedTabState } from '../../tabs/tabs-hydration'
import { buildWorkspaceSessionPayload } from '@/lib/workspace/persistence/workspace-session'
import { closeMobileSessionTabInStore } from '@/runtime/web-session-tabs-sync/closing/mobile-session-tab-close'

vi.mock('@/runtime/rpc/calls/runtime-rpc-call', async (original) =>
  (
    await import('@/runtime/workspace-layout/testing/layout-apply-test-transport.test-fixture')
  ).runtimeRpcClientWithLayoutApply(await original())
)
vi.mock('@/runtime/workspace-layout/frames/runtime-layout-client', async (original) =>
  (
    await import('@/runtime/workspace-layout/testing/layout-apply-test-transport.test-fixture')
  ).runtimeLayoutClientWithTestFrames(await original())
)

const CHILD = 'repo::/child'
const FOLDER = 'folder:feature'
let main: TabsDrawnFromMain
beforeEach(async () => {
  useAppStore.setState(useAppStore.getInitialState(), true)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: catalog fixture supplies only fields editor opening and layout framing read.
  useAppStore.setState({
    activeWorktreeId: FOLDER,
    activeWorkspaceKey: FOLDER,
    activeWorkspaceExecutionHostId: 'local',
    settings: { editorAutoSave: false, editorPreviewTabsEnabled: true },
    repos: [{ id: 'repo', path: '/child', name: 'Child', kind: 'git', executionHostId: 'local' }],
    worktreesByRepo: {
      repo: [
        {
          id: CHILD,
          repoId: 'repo',
          path: '/child',
          hostId: 'local',
          branch: 'feature',
          instanceId: 'child-instance'
        }
      ]
    },
    folderWorkspaces: [
      {
        id: 'feature',
        projectGroupId: 'group',
        name: 'Feature',
        folderPath: '/folder',
        executionHostId: 'local'
      }
    ],
    projectGroups: [{ id: 'group', path: '/folder', executionHostId: 'local' }],
    runtimeEnvironmentCatalogHydrated: true
  } as unknown as Partial<AppState>)
  main = await drawTabsFromMain(useAppStore)
})
afterEach(() => main.close())
function openDiff(workspaceId = FOLDER, path = 'a.ts', preview = false, targetGroupId?: string) {
  useAppStore.getState().openDiff(CHILD, `/child/${path}`, path, 'typescript', false, {
    placementWorkspaceId: workspaceId,
    runtimeEnvironmentId: null,
    executionHostId: 'local',
    preview,
    targetGroupId
  })
}
function tabs(workspaceId: string) {
  return useAppStore.getState().unifiedTabsByWorktree[workspaceId] ?? []
}
function selectSshTwin() {
  useAppStore.setState((state): Partial<AppState> => ({
    activeWorktreeId: CHILD,
    activeWorkspaceKey: worktreeWorkspaceKey(CHILD),
    activeWorkspaceExecutionHostId: 'ssh:builder',
    repos: state.repos.map((repo) => ({
      ...repo,
      connectionId: 'builder',
      executionHostId: 'ssh:builder'
    })),
    worktreesByRepo: {
      repo: [
        ...state.worktreesByRepo.repo!,
        { ...state.worktreesByRepo.repo![0]!, hostId: 'ssh:builder' }
      ]
    },
    sshConnectionStates: new Map([
      [
        'builder',
        {
          targetId: 'builder',
          status: 'connected',
          error: null,
          reconnectAttempt: 0,
          connectionGeneration: 1
        }
      ]
    ])
  }))
}
function patchRemoval(workspaceId: string) {
  useAppStore.setState((state) =>
    removeWorktreeLayout(state, {
      worktreeIds: new Set([workspaceId]),
      tabIds: new Set(),
      activeFileCleared: false
    })
  )
}

it.each(['direct', 'mobile'] as const)(
  '%s close retires a child-owned file whose only placement is in a background folder',
  async (caller) => {
    openDiff()
    await main.settle()
    const tab = tabs(FOLDER)[0]!
    useAppStore.setState({
      activeWorktreeId: CHILD,
      activeWorkspaceKey: worktreeWorkspaceKey(CHILD)
    })
    if (caller === 'direct') {
      useAppStore.getState().closeFile(tab.entityId)
    } else {
      expect(closeMobileSessionTabInStore(useAppStore.getState(), FOLDER, tab.id)).toBe(true)
    }
    await main.settle()
    expect(tabs(FOLDER)).toEqual([])
    expect(useAppStore.getState().openFiles).toEqual([])
    expect(useAppStore.getState().activeWorktreeId).toBe(CHILD)
  }
)

it('mobile close removes the requested folder placement and retains the child view', async () => {
  openDiff()
  openDiff(CHILD)
  await main.settle()
  const folderTab = tabs(FOLDER)[0]!
  const childTab = tabs(CHILD)[0]!
  useAppStore.setState({ activeWorktreeId: CHILD, activeWorkspaceKey: worktreeWorkspaceKey(CHILD) })
  expect(closeMobileSessionTabInStore(useAppStore.getState(), FOLDER, folderTab.id)).toBe(true)
  await main.settle()
  expect(tabs(FOLDER)).toEqual([])
  expect(tabs(CHILD).map((tab) => tab.id)).toEqual([childTab.id])
  expect(useAppStore.getState().openFiles.map((file) => file.id)).toEqual([childTab.entityId])
})

it.each(['file', 'tab'] as const)(
  'mobile %s-id close scopes split copies to the requested workspace',
  async (identity) => {
    openDiff()
    openDiff(CHILD)
    await main.settle()
    const folderTab = tabs(FOLDER)[0]!
    const childTab = tabs(CHILD)[0]!
    const splitGroup = useAppStore
      .getState()
      .createEmptySplitGroup(FOLDER, folderTab.groupId, 'right')
    expect(splitGroup).not.toBeNull()
    openDiff(FOLDER, 'a.ts', false, splitGroup!)
    await main.settle()
    expect(tabs(FOLDER)).toHaveLength(2)
    const splitTab = tabs(FOLDER)[1]!
    const requestedId = identity === 'file' ? folderTab.entityId : folderTab.id
    expect(closeMobileSessionTabInStore(useAppStore.getState(), FOLDER, requestedId)).toBe(true)
    await main.settle()
    expect(tabs(FOLDER).map((tab) => tab.id)).toEqual(identity === 'file' ? [] : [splitTab.id])
    expect(tabs(CHILD).map((tab) => tab.id)).toEqual([childTab.id])
    expect(useAppStore.getState().openFiles.map((file) => file.id)).toEqual([childTab.entityId])
    expect(closeMobileSessionTabInStore(useAppStore.getState(), FOLDER, requestedId)).toBe(false)
    expect(closeMobileSessionTabInStore(useAppStore.getState(), FOLDER, childTab.id)).toBe(false)
    expect(tabs(CHILD).map((tab) => tab.id)).toEqual([childTab.id])
  }
)

it('shares child-owned diff content across folder and child views, with independent close and reopen', async () => {
  openDiff()
  await main.settle()
  const folderTab = tabs(FOLDER)[0]!
  expect(
    workspaceEditorFiles(
      useAppStore.getState().openFiles,
      useAppStore.getState().unifiedTabsByWorktree[FOLDER]
    ).map((file) => [file.worktreeId, file.filePath])
  ).toEqual([[CHILD, '/child/a.ts']])
  expect(tabs(CHILD)).toEqual([])
  useAppStore.getState().reconcileWorktreeTabModel(FOLDER)
  expect(tabs(FOLDER).map((tab) => tab.id)).toEqual([folderTab.id])
  openDiff(CHILD)
  await main.settle()
  expect(tabs(CHILD)[0]?.entityId).toBe(folderTab.entityId)
  expect(useAppStore.getState().openFiles).toHaveLength(1)
  useAppStore.getState().closeUnifiedTab(folderTab.id)
  await main.settle()
  expect(tabs(FOLDER)).toEqual([])
  expect(tabs(CHILD)).toHaveLength(1)
  expect(useAppStore.getState().openFiles).toHaveLength(1)
  expect(useAppStore.getState().reopenClosedEditorTab(FOLDER)).toBe(true)
  await main.settle()
  expect(tabs(FOLDER)[0]?.entityId).toBe(folderTab.entityId)
  expect(useAppStore.getState().openFiles).toHaveLength(1)
})

it('replaces only the folder preview and preserves a child placement and split', async () => {
  openDiff(FOLDER, 'a.ts', true)
  await main.settle()
  const original = tabs(FOLDER)[0]!
  openDiff(CHILD, 'a.ts', true)
  await main.settle()
  const splitGroup = useAppStore
    .getState()
    .createEmptySplitGroup(CHILD, tabs(CHILD)[0]!.groupId, 'right')
  expect(splitGroup).not.toBeNull()
  openDiff(CHILD, 'a.ts', true, splitGroup!)
  await main.settle()
  openDiff(FOLDER, 'b.ts', true)
  await main.settle()
  expect(
    workspaceEditorFiles(
      useAppStore.getState().openFiles,
      useAppStore.getState().unifiedTabsByWorktree[FOLDER]
    ).map((file) => file.relativePath)
  ).toEqual(['b.ts'])
  expect(
    workspaceEditorFiles(
      useAppStore.getState().openFiles,
      useAppStore.getState().unifiedTabsByWorktree[CHILD]
    ).map((file) => file.relativePath)
  ).toEqual(['a.ts'])
  expect(tabs(CHILD)).toHaveLength(2)
  useAppStore.getState().closeUnifiedTab(tabs(CHILD)[0]!.id)
  await main.settle()
  expect(tabs(CHILD)).toHaveLength(1)
  expect(useAppStore.getState().openFiles.some((file) => file.id === original.entityId)).toBe(true)
})

it('removes placements and content in the two independent deletion directions', async () => {
  openDiff()
  openDiff(CHILD)
  await main.settle()
  const childTab = tabs(CHILD)[0]!
  patchRemoval(FOLDER)
  expect(tabs(FOLDER)).toEqual([])
  expect(tabs(CHILD).map((tab) => tab.id)).toEqual([childTab.id])
  expect(useAppStore.getState().openFiles.map((file) => file.worktreeId)).toEqual([CHILD])
  patchRemoval(CHILD)
  expect(useAppStore.getState().openFiles).toEqual([])
  expect(tabs(CHILD)).toEqual([])
  expect(useAppStore.getState().activeFileId).toBeNull()
})

it('does not mirror cross-placed files or dangling groups, and still publishes a normal owner view', async () => {
  useAppStore.getState().openFile(
    {
      filePath: '/child/readme.md',
      relativePath: 'readme.md',
      worktreeId: CHILD,
      language: 'markdown',
      mode: 'edit',
      runtimeEnvironmentId: null
    },
    { placementWorkspaceId: FOLDER, executionHostId: 'local' }
  )
  await main.settle()
  const cross = tabs(FOLDER)[0]!
  const hidden = buildMobileSessionTabSnapshots(useAppStore.getState(), false)
  expect(hidden.flatMap((snapshot) => snapshot.tabs).some((tab) => tab.id === cross.id)).toBe(false)
  expect(hidden.find((snapshot) => snapshot.worktree === CHILD)?.tabs ?? []).toEqual([])
  expect(hidden.find((snapshot) => snapshot.worktree === FOLDER)?.tabGroups ?? []).toEqual([])
  useAppStore.getState().openFile(
    {
      filePath: '/child/readme.md',
      relativePath: 'readme.md',
      worktreeId: CHILD,
      language: 'markdown',
      mode: 'edit',
      runtimeEnvironmentId: null
    },
    { executionHostId: 'local' }
  )
  await main.settle()
  const published = buildMobileSessionTabSnapshots(useAppStore.getState(), false)
  expect(
    published.find((snapshot) => snapshot.worktree === CHILD)?.tabs.map((tab) => tab.id)
  ).toEqual([tabs(CHILD)[0]!.id])
  expect(useAppStore.getState().openFiles).toHaveLength(1)
})

it.runIf(ORCA_LAYOUT_OWNER_IS_MAIN)(
  'protects content while main owns the open, and releases a refused placement',
  async () => {
    layoutApplyTestTransport.answerWith('pending')
    openDiff()
    const file = useAppStore.getState().openFiles[0]!
    expect(hasPendingEntityTab(FOLDER, file.id)).toBe(true)
    expect(tabs(FOLDER)).toEqual([])
    expect(tabs(CHILD)).toEqual([])
    expect(
      buildMobileSessionTabSnapshots(useAppStore.getState(), false).flatMap(
        (snapshot) => snapshot.tabs
      )
    ).toEqual([])
    layoutApplyTestTransport.answerPending({ ok: false, code: 'invalid_params' })
    await main.settle()
    expect(hasPendingEntityTab(FOLDER, file.id)).toBe(false)
    expect(useAppStore.getState().openFiles).toEqual([])
  }
)

it('restores legacy edit membership only at hydration, never inventing tabs for modern unreferenced content', () => {
  const session = buildWorkspaceSessionPayload(useAppStore.getState())
  const files = [
    {
      filePath: '/child/legacy.ts',
      relativePath: 'legacy.ts',
      worktreeId: CHILD,
      language: 'typescript'
    }
  ]
  const legacy = buildHydratedTabState(
    { ...session, unifiedTabs: undefined, openFilesByWorktree: { [CHILD]: files } },
    new Set([CHILD])
  )
  expect(legacy.unifiedTabsByWorktree[CHILD]?.map((tab) => tab.entityId)).toEqual([
    '/child/legacy.ts'
  ])
  const modern = buildHydratedTabState(
    { ...session, unifiedTabs: {}, openFilesByWorktree: { [CHILD]: files } },
    new Set([CHILD])
  )
  expect(modern.unifiedTabsByWorktree[CHILD] ?? []).toEqual([])
})

it('saves an untracked edit and its unsaved draft under the child and restores child membership', async () => {
  const id = useAppStore.getState().openFile(
    {
      filePath: '/child/readme.md',
      relativePath: 'readme.md',
      worktreeId: CHILD,
      language: 'markdown',
      mode: 'edit',
      runtimeEnvironmentId: null
    },
    { placementWorkspaceId: FOLDER, executionHostId: 'local' }
  )
  await main.settle()
  useAppStore.getState().setEditorDraft(id, 'unsaved child text')
  useAppStore.getState().markFileDirty(id, true)
  const session = buildWorkspaceSessionPayload(useAppStore.getState())
  expect(session.openFilesByWorktree?.[FOLDER]).toBeUndefined()
  expect(session.openFilesByWorktree?.[CHILD]?.[0]?.dirtyDraftContent).toBe('unsaved child text')
  const hydrated = buildHydratedTabState(session, new Set([CHILD, FOLDER]))
  expect(hydrated.unifiedTabsByWorktree[FOLDER] ?? []).toEqual([])
  expect(hydrated.unifiedTabsByWorktree[CHILD]?.map((tab) => tab.entityId)).toEqual([id])
})

it('retires a placement intent deleted during content publication without creating a ghost tab', async () => {
  let retired = false
  const stop = useAppStore.subscribe((state) => {
    if (!retired && state.openFiles.length > 0 && tabs(FOLDER).length === 0) {
      retired = true
      patchRemoval(FOLDER)
    }
  })
  try {
    openDiff()
    await main.settle()
  } finally {
    stop()
  }
  expect(retired).toBe(true)
  expect(tabs(FOLDER)).toEqual([])
  expect(tabs(CHILD)).toEqual([])
  expect(useAppStore.getState().openFiles).toEqual([])
})

it('dirty SSH edit tab survives restart round trip (no drop, no duplicate on reopen)', async () => {
  useAppStore.setState((state): Partial<AppState> => ({
    activeWorktreeId: CHILD,
    activeWorkspaceKey: worktreeWorkspaceKey(CHILD),
    activeWorkspaceExecutionHostId: 'ssh:builder',
    repos: state.repos.map((repo) => ({
      ...repo,
      connectionId: 'builder',
      executionHostId: 'ssh:builder'
    })),
    worktreesByRepo: {
      repo: state.worktreesByRepo.repo!.map((worktree) => ({ ...worktree, hostId: 'ssh:builder' }))
    },
    sshConnectionStates: new Map([
      [
        'builder',
        {
          targetId: 'builder',
          status: 'connected',
          error: null,
          reconnectAttempt: 0,
          connectionGeneration: 1
        }
      ]
    ])
  }))
  const file = {
    filePath: '/child/ssh.ts',
    relativePath: 'ssh.ts',
    worktreeId: CHILD,
    language: 'typescript',
    mode: 'edit' as const,
    runtimeEnvironmentId: null
  }
  const id = useAppStore
    .getState()
    .openFile(file, { executionHostId: 'ssh:builder', preview: false })
  await main.settle()
  useAppStore.getState().setEditorDraft(id, 'unsaved SSH text')
  useAppStore.getState().markFileDirty(id, true)
  const saved = buildWorkspaceSessionPayload(useAppStore.getState())
  const restoredTabs = buildHydratedTabState(saved, new Set([CHILD]))
  useAppStore.setState({ ...restoredTabs, openFiles: [], editorDrafts: {} })
  useAppStore.getState().hydrateEditorSession(saved)
  useAppStore.getState().reconcileWorktreeTabModel(CHILD)
  expect(tabs(CHILD).map((tab) => tab.entityId)).toEqual(['/child/ssh.ts'])
  expect(useAppStore.getState().editorDrafts['/child/ssh.ts']).toBe('unsaved SSH text')
  const reopened = useAppStore
    .getState()
    .openFile(file, { executionHostId: 'ssh:builder', preview: false })
  await main.settle()
  expect(reopened).toBe('/child/ssh.ts')
  expect(useAppStore.getState().openFiles).toHaveLength(1)
  expect(tabs(CHILD)).toHaveLength(1)
  expect(useAppStore.getState().editorDrafts[reopened]).toBe('unsaved SSH text')
})

it.each([false, true])(
  'preserves different-owner local and SSH collision drafts on restart (bare owner closed: %s)',
  async (closeLocal) => {
    const file = {
      filePath: '/child/twin.ts',
      relativePath: 'twin.ts',
      language: 'typescript',
      mode: 'edit' as const,
      runtimeEnvironmentId: null
    }
    const localId = useAppStore
      .getState()
      .openFile({ ...file, worktreeId: FOLDER }, { executionHostId: 'local', preview: false })
    await main.settle()
    useAppStore.getState().setEditorDraft(localId, 'local draft')
    useAppStore.getState().markFileDirty(localId, true)
    selectSshTwin()
    const id = useAppStore
      .getState()
      .openFile({ ...file, worktreeId: CHILD }, { executionHostId: 'ssh:builder', preview: false })
    await main.settle()
    expect(localId).toBe('/child/twin.ts')
    expect(id).toBe('editor:repo%3A%3A%2Fchild:local:%2Fchild%2Ftwin.ts')
    expect(
      useAppStore.getState().openFiles.find((file) => file.id === id)?.operationProvenance
        ?.generation.route.executionHostId
    ).toBe('ssh:builder')
    useAppStore.getState().setEditorDraft(id, 'SSH draft')
    useAppStore.getState().markFileDirty(id, true)
    if (closeLocal) {
      useAppStore.getState().closeFile(localId)
      await main.settle()
    }
    const saved = buildWorkspaceSessionPayload(useAppStore.getState())
    const restoredTabs = buildHydratedTabState(saved, new Set([CHILD, FOLDER]))
    useAppStore.setState({ ...restoredTabs, openFiles: [], editorDrafts: {} })
    useAppStore.getState().hydrateEditorSession(saved)
    useAppStore.getState().reconcileWorktreeTabModel(CHILD)
    useAppStore.getState().reconcileWorktreeTabModel(FOLDER)
    expect(tabs(CHILD).map((tab) => tab.entityId)).toEqual([
      'editor:repo%3A%3A%2Fchild:local:%2Fchild%2Ftwin.ts'
    ])
    expect(tabs(FOLDER).map((tab) => tab.entityId)).toEqual(closeLocal ? [] : ['/child/twin.ts'])
    expect(useAppStore.getState().editorDrafts[id]).toBe('SSH draft')
    if (!closeLocal) {
      expect(useAppStore.getState().editorDrafts['/child/twin.ts']).toBe('local draft')
    }
    const reopened = useAppStore
      .getState()
      .openFile({ ...file, worktreeId: CHILD }, { executionHostId: 'ssh:builder', preview: false })
    await main.settle()
    expect(reopened).toBe(id)
    expect(tabs(CHILD)).toHaveLength(1)
    expect(useAppStore.getState().openFiles).toHaveLength(closeLocal ? 1 : 2)
    expect(useAppStore.getState().editorDrafts[reopened]).toBe('SSH draft')
  }
)

it('reuses the same-worktree runtime/path edit across host selection, retaining its draft and provenance', async () => {
  const file = {
    filePath: '/child/twin.ts',
    relativePath: 'twin.ts',
    worktreeId: CHILD,
    language: 'typescript',
    mode: 'edit' as const,
    runtimeEnvironmentId: null
  }
  const originalId = useAppStore
    .getState()
    .openFile(file, { executionHostId: 'local', preview: false })
  await main.settle()
  const original = useAppStore.getState().openFiles.find((file) => file.id === originalId)!
  expect(originalId).toBe('/child/twin.ts')
  expect(original.operationProvenance?.generation.route.executionHostId).toBe('local')
  useAppStore.getState().setEditorDraft(originalId, 'original local draft')
  useAppStore.getState().markFileDirty(originalId, true)
  selectSshTwin()
  const reused = useAppStore
    .getState()
    .openFile(file, { executionHostId: 'ssh:builder', preview: false })
  await main.settle()
  expect(reused).toBe('/child/twin.ts')
  expect(useAppStore.getState().openFiles).toHaveLength(1)
  expect(useAppStore.getState().openFiles[0]?.operationProvenance).toBe(
    original.operationProvenance
  )
  expect(useAppStore.getState().openFiles[0]?.isDirty).toBe(true)
  expect(useAppStore.getState().editorDrafts[reused]).toBe('original local draft')
  expect(tabs(CHILD).map((tab) => tab.entityId)).toEqual(['/child/twin.ts'])

  const saved = buildWorkspaceSessionPayload(useAppStore.getState())
  const restoredTabs = buildHydratedTabState(saved, new Set([CHILD]))
  useAppStore.setState({ ...restoredTabs, openFiles: [], editorDrafts: {} })
  useAppStore.getState().hydrateEditorSession(saved)
  useAppStore.getState().reconcileWorktreeTabModel(CHILD)
  expect(tabs(CHILD).map((tab) => tab.entityId)).toEqual(['/child/twin.ts'])
  expect(useAppStore.getState().editorDrafts['/child/twin.ts']).toBe('original local draft')
  const reopened = useAppStore
    .getState()
    .openFile(file, { executionHostId: 'ssh:builder', preview: false })
  await main.settle()
  expect(reopened).toBe('/child/twin.ts')
  expect(useAppStore.getState().openFiles).toHaveLength(1)
  expect(tabs(CHILD)).toHaveLength(1)
  expect(useAppStore.getState().editorDrafts[reopened]).toBe('original local draft')
})

it('moves an edit placement to its content owner when the folder is deleted', async () => {
  const id = useAppStore.getState().openFile(
    {
      filePath: '/child/note.md',
      relativePath: 'note.md',
      language: 'markdown',
      worktreeId: CHILD,
      mode: 'edit',
      runtimeEnvironmentId: null
    },
    { placementWorkspaceId: FOLDER, executionHostId: 'local', preview: false }
  )
  await main.settle()
  useAppStore.getState().setEditorDraft(id, 'retained draft')
  useAppStore.getState().markFileDirty(id, true)
  patchRemoval(FOLDER)
  expect(tabs(FOLDER)).toEqual([])
  expect(tabs(CHILD).map((tab) => tab.entityId)).toEqual(['/child/note.md'])
  const state = useAppStore.getState()
  expect(state.groupsByWorktree[CHILD]?.[0]?.tabOrder).toEqual([tabs(CHILD)[0]!.id])
  expect(state.activeFileIdByWorktree[CHILD]).toBe('/child/note.md')
  expect(state.editorDrafts[id]).toBe('retained draft')
  expect(state.openFiles).toHaveLength(1)
})
