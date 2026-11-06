// @vitest-environment happy-dom
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import { drawTabsFromMain, type TabsDrawnFromMain } from './tabs-drawn-from-main.test-fixture'
import { layoutApplyTestTransport } from '@/runtime/layout-apply-test-transport.test-fixture'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../shared/layout-owner-switch'
import { hasPendingEntityTab } from '@/runtime/layout-owner-pending-tabs'
import { buildMobileSessionTabSnapshots } from '@/runtime/sync-runtime-graph/mobile-session-snapshots'
import { workspaceEditorFiles } from './editor/tabs/workspace-editor-files'
import { removeWorktreeLayout } from './tabs/worktree-layout-lifecycle'
import { buildHydratedTabState } from './tabs-hydration'
import { buildWorkspaceSessionPayload } from '@/lib/workspace-session'

vi.mock('@/runtime/runtime-rpc-client', async (original) =>
  (
    await import('@/runtime/layout-apply-test-transport.test-fixture')
  ).runtimeRpcClientWithLayoutApply(await original())
)
vi.mock('@/runtime/runtime-layout-client', async (original) =>
  (
    await import('@/runtime/layout-apply-test-transport.test-fixture')
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
function patchRemoval(workspaceId: string) {
  useAppStore.setState((state) =>
    removeWorktreeLayout(state, {
      worktreeIds: new Set([workspaceId]),
      tabIds: new Set(),
      activeFileCleared: false
    })
  )
}

it('shares child-owned diff content across folder and child views, with independent close and reopen', async () => {
  openDiff()
  await main.settle()
  const folderTab = tabs(FOLDER)[0]!
  expect(
    workspaceEditorFiles(useAppStore.getState(), FOLDER).map((file) => [
      file.worktreeId,
      file.filePath
    ])
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
    workspaceEditorFiles(useAppStore.getState(), FOLDER).map((file) => file.relativePath)
  ).toEqual(['b.ts'])
  expect(
    workspaceEditorFiles(useAppStore.getState(), CHILD).map((file) => file.relativePath)
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
