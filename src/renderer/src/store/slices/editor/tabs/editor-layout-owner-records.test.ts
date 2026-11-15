// @vitest-environment happy-dom

// Main frames draw editor tabs; opens carry view data for diff/preview/conflict in layout-owner builds.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store/index'
import { remapOpenEditorTabsForPathChange } from '@/lib/editor/file-operations/remap-open-editor-tabs-for-path-change'
import type { AppState } from '@/store/types'
import type { LayoutCommand } from '../../../../../../shared/workspace-layout/workspace-layout-command-types'
import { layoutApplyTestTransport } from '@/runtime/workspace-layout/testing/layout-apply-test-transport.test-fixture'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../../../shared/layout-owner-switch'
import {
  editorMoveOwnerFromContext,
  type EditorMoveOwner
} from '@/lib/editor/file-operations/open-editor-move-owner'
import {
  drawTabsFromMain,
  type TabsDrawnFromMain
} from '../../tabs/tabs-drawn-from-main.test-fixture'
import { contentRekeyOutcome } from '@/runtime/workspace-layout/intents/layout-owner-content-rekeys'

vi.mock('@/runtime/rpc/calls/runtime-rpc-call', async (importOriginal) =>
  (
    await import('@/runtime/workspace-layout/testing/layout-apply-test-transport.test-fixture')
  ).runtimeRpcClientWithLayoutApply(await importOriginal())
)
vi.mock('@/runtime/workspace-layout/frames/runtime-layout-client', async (importOriginal) =>
  (
    await import('@/runtime/workspace-layout/testing/layout-apply-test-transport.test-fixture')
  ).runtimeLayoutClientWithTestFrames(await importOriginal())
)

const WT = 'repo-a::/repo-a'
const SIBLING = 'repo-a::/repo-a-2'

let main: TabsDrawnFromMain

beforeEach(async () => {
  useAppStore.setState(useAppStore.getInitialState(), true)
  useAppStore.setState(
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a partial catalog with only the fields editor opens and frames read.
    {
      activeWorktreeId: WT,
      settings: { editorAutoSave: false },
      repos: [{ id: 'repo-a', path: '/repo-a', kind: 'git', executionHostId: 'local' }],
      worktreesByRepo: {
        'repo-a': [
          { id: WT, repoId: 'repo-a', path: '/repo-a', hostId: 'local', branch: '' },
          { id: SIBLING, repoId: 'repo-a', path: '/repo-a-2', hostId: 'local', branch: '' }
        ]
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
  main = await drawTabsFromMain(useAppStore)
})

afterEach(() => main.close())

function openEdit(worktreeId: string, filePath: string, relativePath: string): string {
  return useAppStore.getState().openFile(
    {
      filePath,
      relativePath,
      worktreeId,
      runtimeEnvironmentId: null,
      language: 'typescript',
      mode: 'edit'
    },
    { suppressActiveRuntimeFallback: true }
  )
}

function localMoveOwner(worktreeId: string | undefined): EditorMoveOwner {
  return editorMoveOwnerFromContext({ target: { kind: 'local' } }, worktreeId)
}

describe.runIf(ORCA_LAYOUT_OWNER_IS_MAIN)('open files renamed on disk, layout-owner build', () => {
  it('changes neither workspace when main refuses the rename in one of them', async () => {
    openEdit(WT, '/repo-a/src/a.ts', 'src/a.ts')
    openEdit(SIBLING, '/repo-a/src/a.ts', 'src/a.ts')
    await main.settle()
    const before = useAppStore.getState()
    const mainBefore = layoutApplyTestTransport.mainModel
    const touchesSibling = (command: LayoutCommand): boolean =>
      command.workspace === SIBLING ||
      (command.type === 'renameEditorFiles' &&
        (command.alsoIn ?? []).some((entry) => entry.workspace === SIBLING))
    layoutApplyTestTransport.answerWith((command) =>
      touchesSibling(command) ? { ok: false, code: 'tab_exists' } : 'apply'
    )

    remapOpenEditorTabsForPathChange({
      fromPath: '/repo-a/src',
      toPath: '/repo-a/lib',
      worktreePath: '/repo-a',
      worktreeId: WT,
      owner: localMoveOwner(WT)
    })

    expect(await contentRekeyOutcome(before.openFiles.map((file) => file.id))).toBe(false)
    await main.settle()
    expect(layoutApplyTestTransport.mainModel).toEqual(mainBefore)
    expect(useAppStore.getState().openFiles).toEqual(before.openFiles)
    expect(useAppStore.getState().unifiedTabsByWorktree).toEqual(before.unifiedTabsByWorktree)
  })

  it('rekeys a dirty draft and the autosave gate in the same update as the frame', async () => {
    const oldId = openEdit(WT, '/repo-a/src/a.ts', 'src/a.ts')
    await main.settle()
    useAppStore.getState().setEditorDraft(oldId, 'unsaved')
    useAppStore.getState().markFileDirty(oldId, true)
    const torn: string[] = []
    const unsubscribe = useAppStore.subscribe((state) => {
      const files = new Map(state.openFiles.map((file) => [file.id, file]))
      for (const tab of state.unifiedTabsByWorktree[WT] ?? []) {
        if (!files.has(tab.entityId)) {
          torn.push(`tab for ${tab.entityId} without its file`)
        }
      }
      for (const fileId of Object.keys(state.editorDrafts)) {
        if (!files.has(fileId)) {
          torn.push(`draft for ${fileId} without its file`)
        }
      }
    })

    expect(
      remapOpenEditorTabsForPathChange({
        fromPath: '/repo-a/src',
        toPath: '/repo-a/lib',
        worktreePath: '/repo-a',
        worktreeId: WT,
        owner: localMoveOwner(WT),
        moveOperationId: 'move-1'
      })
    ).toEqual({ ok: true })
    // Nothing is rekeyed before main's frame.
    expect(useAppStore.getState().editorDrafts).toEqual({ [oldId]: 'unsaved' })
    expect(await contentRekeyOutcome([oldId])).toBe(true)
    await main.settle()
    unsubscribe()

    expect(torn).toEqual([])
    const state = useAppStore.getState()
    expect(state.openFiles).toEqual([
      expect.objectContaining({
        id: '/repo-a/lib/a.ts',
        isDirty: true,
        pendingSelfMoveEcho: { operationId: 'move-1', targetPath: '/repo-a/lib/a.ts' }
      })
    ])
    expect(state.editorDrafts).toEqual({ '/repo-a/lib/a.ts': 'unsaved' })
  })
})
