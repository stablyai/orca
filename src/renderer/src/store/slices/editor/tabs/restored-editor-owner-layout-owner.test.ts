// @vitest-environment happy-dom

// With main layout ownership, restored-file moves and content rekeys must arrive together in main’s frame.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store/index'
import { captureEditorFileOperationProvenance } from '@/lib/editor/file-operations/editor-file-operation-provenance'
import type { AppState } from '@/store/types'
import { layoutApplyTestTransport } from '@/runtime/workspace-layout/testing/layout-apply-test-transport.test-fixture'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../../../shared/layout-owner-switch'
import type { LayoutCommand } from '../../../../../../shared/workspace-layout/workspace-layout-command-types'
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

const SOURCE = 'repo-a::/repo-a'
const TARGET = 'repo-b::/repo-b'
const FILE_PATH = '/repo-b/docs/readme.md'

let main: TabsDrawnFromMain
let sentSoFar = 0

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

beforeEach(async () => {
  installWorkspaceState()
  main = await drawTabsFromMain(useAppStore)
  sentSoFar = 0
})

afterEach(() => main.close())

/** What the window sent since the last call, once main answered it and its frames are drawn. */
async function settledSent(): Promise<LayoutCommand[]> {
  await main.settle()
  const sent = layoutApplyTestTransport.sent.slice(sentSoFar)
  sentSoFar = layoutApplyTestTransport.sent.length
  return [...sent]
}

/** Non-empty groups only: an emptied group is never saved. */
function windowView(worktreeId: string) {
  const state = useAppStore.getState()
  const tabs = state.unifiedTabsByWorktree[worktreeId] ?? []
  return (state.groupsByWorktree[worktreeId] ?? [])
    .filter((group) => group.tabOrder.length > 0)
    .map((group) => ({
      group: group.id,
      tabs: group.tabOrder.map((tabId) => {
        const tab = tabs.find((entry) => entry.id === tabId)!
        return { id: tab.id, entity: tab.entityId }
      })
    }))
}

function openRestoredSource(): string {
  return useAppStore.getState().openFile(
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
}

function reparent(
  fileId: string,
  targetWorktreeId = TARGET,
  targetRelativePath = 'docs/readme.md'
) {
  const state = useAppStore.getState()
  state.setRestoredEditorOwnerMigrationPending(fileId, true)
  return state.reparentRestoredEditorFileOwner({
    fileId,
    targetWorktreeId,
    targetRelativePath,
    targetExecutionHostId: 'local',
    targetRuntimeEnvironmentId: null,
    targetOperationProvenance: captureEditorFileOperationProvenance(
      state,
      targetWorktreeId,
      null,
      true
    )
  })
}

describe.runIf(ORCA_LAYOUT_OWNER_IS_MAIN)(
  'restored editor tab moved to its owning workspace, layout-owner build',
  () => {
    it('moves the content in the same store update as the frame that shows the move', async () => {
      const oldId = openRestoredSource()
      await settledSent()
      useAppStore.getState().setEditorDraft(oldId, 'unsaved')
      useAppStore.getState().markFileDirty(oldId, true)
      const torn: string[] = []
      const unsubscribe = useAppStore.subscribe((state) => {
        const fileIds = new Set(state.openFiles.map((file) => file.id))
        for (const tab of Object.values(state.unifiedTabsByWorktree).flat()) {
          if (tab.contentType === 'editor' && !fileIds.has(tab.entityId)) {
            torn.push(`tab for ${tab.entityId} without its file`)
          }
        }
        for (const fileId of Object.keys(state.editorDrafts)) {
          if (!fileIds.has(fileId)) {
            torn.push(`draft for ${fileId} without its file`)
          }
        }
      })

      const result = reparent(oldId)

      // Nothing moves before main's frame.
      expect(windowView(SOURCE)[0]!.tabs).toEqual([expect.objectContaining({ entity: oldId })])
      expect(useAppStore.getState().openFiles.map((file) => file.id)).toEqual([oldId])
      await settledSent()
      unsubscribe()
      expect(torn).toEqual([])
      const newId = result.ok ? result.fileId : ''
      expect(windowView(TARGET)[0]!.tabs).toEqual([expect.objectContaining({ entity: newId })])
      expect(useAppStore.getState().openFiles).toEqual([
        expect.objectContaining({ id: newId, worktreeId: TARGET, isDirty: true })
      ])
      expect(useAppStore.getState().editorDrafts).toEqual({ [newId]: 'unsaved' })
    })

    it('changes nothing when main refuses the move', async () => {
      const oldId = openRestoredSource()
      await settledSent()
      useAppStore.getState().setEditorDraft(oldId, 'unsaved')
      const before = useAppStore.getState()
      layoutApplyTestTransport.answerWith({ refuse: 'group_not_found' })

      const result = reparent(oldId)

      expect(result.ok).toBe(true)
      expect(await contentRekeyOutcome([oldId])).toBe(false)
      expect(await settledSent()).toEqual([expect.objectContaining({ type: 'moveTabToWorkspace' })])
      const after = useAppStore.getState()
      expect(after.unifiedTabsByWorktree).toEqual(before.unifiedTabsByWorktree)
      expect(after.groupsByWorktree).toEqual(before.groupsByWorktree)
      expect(after.editorDrafts).toEqual({ [oldId]: 'unsaved' })
      expect(after.openFiles).toEqual([
        expect.objectContaining({ id: oldId, worktreeId: SOURCE, pendingOwnerMigration: undefined })
      ])
    })
  }
)
