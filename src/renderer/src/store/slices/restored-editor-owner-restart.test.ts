// @vitest-environment happy-dom

import { describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { captureEditorFileOperationProvenance } from '@/lib/editor-file-operation-owner'
import type { AppState } from '@/store/types'
import { buildWorkspaceSessionPayload } from '../../lib/workspace-session'
import { drawTabsFromMain, type TabsDrawnFromMain } from './tabs-drawn-from-main.test-fixture'

// Main's answer to the window's layout commands, as a switch-on build sends them.
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

const SOURCE = 'repo-a::/repo-a'
const TARGET = 'repo-b::/repo-b'
const FILE_PATH = '/repo-b/docs/readme.md'

function installWorkspaceState(): void {
  useAppStore.setState(useAppStore.getInitialState(), true)
  useAppStore.setState(
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a partial catalog with only the fields the owner route reads, as restored-editor-owner-reparent.test.ts uses.
    {
      activeWorktreeId: SOURCE,
      settings: { editorAutoSave: false },
      repos: [
        { id: 'repo-a', path: '/repo-a', kind: 'git', executionHostId: 'local' },
        { id: 'repo-b', path: '/repo-b', kind: 'git', executionHostId: 'local' }
      ],
      worktreesByRepo: {
        'repo-a': [{ id: SOURCE, repoId: 'repo-a', path: '/repo-a', hostId: 'local', branch: '' }],
        'repo-b': [{ id: TARGET, repoId: 'repo-b', path: '/repo-b', hostId: 'local', branch: '' }]
      },
      detectedWorktreesByRepo: {},
      runtimeEnvironments: [],
      runtimeEnvironmentCatalogHydrated: true,
      removedRuntimeEnvironmentIds: new Set(),
      sshConnectionStates: new Map(),
      sshStateByEnvironment: new Map(),
      folderWorkspaces: [],
      projectGroups: [],
      gitStatusHugeByWorktree: {}
    } as unknown as Partial<AppState>
  )
}

/** The restored tab's file loaded under a sibling workspace, and Orca moved the tab there (F42). */
async function openAndMoveToOwner(main: TabsDrawnFromMain): Promise<void> {
  const fileId = useAppStore.getState().openFile(
    {
      filePath: FILE_PATH,
      relativePath: FILE_PATH,
      worktreeId: SOURCE,
      runtimeEnvironmentId: null,
      language: 'markdown',
      mode: 'edit'
    },
    { suppressActiveRuntimeFallback: true }
  )
  // A layout-owner build draws the restored tab from main's frame before Orca can move it.
  await main.settle()
  const state = useAppStore.getState()
  state.setRestoredEditorOwnerMigrationPending(fileId, true)
  const moved = state.reparentRestoredEditorFileOwner({
    fileId,
    targetWorktreeId: TARGET,
    targetRelativePath: 'docs/readme.md',
    targetExecutionHostId: 'local',
    targetRuntimeEnvironmentId: null,
    targetOperationProvenance: captureEditorFileOperationProvenance(state, TARGET, null, true)
  })
  expect(moved.ok).toBe(true)
  await main.settle()
}

describe('an editor tab Orca moved to the workspace owning its file', () => {
  it('is still open in that workspace after a restart', async () => {
    installWorkspaceState()
    const main = await drawTabsFromMain(useAppStore)
    await openAndMoveToOwner(main)
    main.close()
    const saved = buildWorkspaceSessionPayload(useAppStore.getState())

    installWorkspaceState()
    useAppStore.getState().hydrateTabsSession(saved)
    useAppStore.getState().hydrateEditorSession(saved)

    const state = useAppStore.getState()
    const file = state.openFiles.find((candidate) => candidate.filePath === FILE_PATH)
    expect(file).toMatchObject({ worktreeId: TARGET })
    expect(state.unifiedTabsByWorktree[TARGET]).toEqual([
      expect.objectContaining({
        contentType: 'editor',
        entityId: file!.id,
        worktreeId: TARGET,
        executionHostId: 'local'
      })
    ])
    expect(state.groupsByWorktree[TARGET]?.flatMap((group) => group.tabOrder)).toEqual(
      state.unifiedTabsByWorktree[TARGET]!.map((tab) => tab.id)
    )
  })
})
