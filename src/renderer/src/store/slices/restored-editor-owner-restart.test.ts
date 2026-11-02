// @vitest-environment happy-dom

import { describe, expect, it } from 'vitest'
import { useAppStore } from '@/store'
import { captureEditorFileOperationProvenance } from '@/lib/editor-file-operation-owner'
import type { AppState } from '@/store/types'
import { buildWorkspaceSessionPayload } from '../../lib/workspace-session'

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
function openAndMoveToOwner(): void {
  const state = useAppStore.getState()
  const fileId = state.openFile(
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
}

describe('an editor tab Orca moved to the workspace owning its file', () => {
  it('is still open in that workspace after a restart', () => {
    installWorkspaceState()
    openAndMoveToOwner()
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
