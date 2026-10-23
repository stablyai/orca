// @vitest-environment happy-dom

// A restored editor tab moved to its owning workspace in a layout-owner build (ORCA_LAYOUT_OWNER=main):
// the window asks main to move it under the ids it proposes, and main's frame draws the move with
// the file's content rekeyed in the same update.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { captureEditorFileOperationProvenance } from '@/lib/editor-file-operation-owner'
import type { AppState } from '@/store/types'
import { layoutApplyTestTransport } from '@/runtime/layout-apply-test-transport.test-fixture'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../shared/layout-owner-switch'
import type { LayoutCommand } from '../../../../shared/workspace-layout/workspace-layout-command-types'
import { drawTabsFromMain, type TabsDrawnFromMain } from './tabs-drawn-from-main.test-fixture'
import { contentRekeyOutcome } from '@/runtime/layout-owner-content-rekeys'

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

const mainWorkspace = (worktreeId: string) =>
  layoutApplyTestTransport.mainModel!.workspaces[worktreeId]

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

function mainView(worktreeId: string) {
  const workspace = mainWorkspace(worktreeId)
  return (workspace?.groups ?? []).map((group) => ({
    group: group.id,
    tabs: group.tabOrder.map((tabId) => {
      const tab = workspace!.tabs.find((entry) => entry.id === tabId)!
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

/** The window's move when the restored tab's file loads under a sibling workspace (F42). */
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

function expectMainMatchesWindow(): void {
  for (const worktreeId of [SOURCE, TARGET]) {
    expect(mainView(worktreeId)).toEqual(windowView(worktreeId))
  }
}

describe.runIf(ORCA_LAYOUT_OWNER_IS_MAIN)(
  'restored editor tab moved to its owning workspace, layout-owner build',
  () => {
    it('records the move under the ids and group the window chose', async () => {
      const oldId = openRestoredSource()
      await settledSent()
      expectMainMatchesWindow()

      const result = reparent(oldId)

      expect(result.ok).toBe(true)
      const [command] = await settledSent()
      expect(command).toMatchObject({
        type: 'moveTabToWorkspace',
        workspace: SOURCE,
        toWorkspace: TARGET,
        file: { filePath: FILE_PATH, relativePath: 'docs/readme.md' }
      })
      expect(windowView(TARGET)[0]!.tabs).toEqual([
        expect.objectContaining({ entity: result.ok ? result.fileId : '' })
      ])
      expectMainMatchesWindow()
      expect(mainWorkspace(TARGET)!.editorFiles).toEqual([
        expect.objectContaining({ filePath: FILE_PATH, relativePath: 'docs/readme.md' })
      ])
      expect(mainWorkspace(SOURCE)!.editorFiles).toEqual([])
    })

    it("appends to the target's active group after its own tabs, with a dependent preview", async () => {
      const oldId = openRestoredSource()
      useAppStore.getState().openMarkdownPreview(
        {
          filePath: FILE_PATH,
          relativePath: FILE_PATH,
          worktreeId: SOURCE,
          runtimeEnvironmentId: null,
          language: 'markdown'
        },
        { sourceFileId: oldId }
      )
      useAppStore.getState().openFile(
        {
          filePath: '/repo-b/a.ts',
          relativePath: 'a.ts',
          worktreeId: TARGET,
          runtimeEnvironmentId: null,
          language: 'typescript',
          mode: 'edit'
        },
        { suppressActiveRuntimeFallback: true }
      )
      await settledSent()
      expectMainMatchesWindow()
      expect(windowView(SOURCE)[0]!.tabs).toHaveLength(2)

      expect(reparent(oldId).ok).toBe(true)

      const [command] = await settledSent()
      expect(command).toMatchObject({ type: 'moveTabToWorkspace' })
      expect(command!.type === 'moveTabToWorkspace' && command.tabs).toHaveLength(2)
      expect(windowView(TARGET)[0]!.tabs).toHaveLength(3)
      expectMainMatchesWindow()
    })

    it('records a re-own inside the same local workspace as a rename with its new record', async () => {
      const inSourcePath = '/repo-a/notes.md'
      const oldId = useAppStore.getState().openFile(
        {
          filePath: inSourcePath,
          relativePath: inSourcePath,
          worktreeId: SOURCE,
          runtimeEnvironmentId: null,
          language: 'markdown',
          mode: 'edit'
        },
        { suppressActiveRuntimeFallback: true }
      )
      await settledSent()
      expectMainMatchesWindow()

      const result = reparent(oldId, SOURCE, 'notes.md')

      expect(result).toMatchObject({ ok: true })
      const [command] = await settledSent()
      expect(command).toMatchObject({ type: 'renameEditorFiles', workspace: SOURCE })
      expectMainMatchesWindow()
      expect(mainWorkspace(SOURCE)!.editorFiles).toEqual([
        expect.objectContaining({ filePath: inSourcePath, relativePath: 'notes.md' })
      ])
    })

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

    it('moves a file restored in two splits as one tab, rekeyed with the frame that shows it', async () => {
      const oldId = openRestoredSource()
      await settledSent()
      const left = useAppStore.getState().groupsByWorktree[SOURCE]?.[0]?.id ?? ''
      const right = useAppStore.getState().createEmptySplitGroup(SOURCE, left, 'right') ?? ''
      useAppStore.getState().openFile(
        {
          filePath: FILE_PATH,
          relativePath: FILE_PATH,
          worktreeId: SOURCE,
          runtimeEnvironmentId: null,
          language: 'markdown',
          mode: 'edit'
        },
        { suppressActiveRuntimeFallback: true, targetGroupId: right }
      )
      await settledSent()
      expect(windowView(SOURCE).map((group) => group.tabs.length)).toEqual([1, 1])

      const result = reparent(oldId)
      const newId = result.ok ? result.fileId : ''
      const outcome = contentRekeyOutcome([oldId])
      await settledSent()

      expect(await outcome).toBe(true)
      expect(windowView(TARGET)).toEqual([
        { group: expect.any(String), tabs: [expect.objectContaining({ entity: newId })] }
      ])
      expect(windowView(SOURCE)).toEqual([])
      expectMainMatchesWindow()
      expect(useAppStore.getState().openFiles).toEqual([
        expect.objectContaining({ id: newId, worktreeId: TARGET })
      ])
      const shown = windowView(TARGET)[0]?.tabs[0]?.id
      expect(useAppStore.getState().groupsByWorktree[TARGET]?.[0]?.activeTabId).toBe(shown)
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

    it("keeps a moved view tab's view, under the file's new owner", async () => {
      const oldId = openRestoredSource()
      useAppStore.getState().openMarkdownPreview(
        {
          filePath: FILE_PATH,
          relativePath: FILE_PATH,
          worktreeId: SOURCE,
          runtimeEnvironmentId: null,
          language: 'markdown'
        },
        { sourceFileId: oldId }
      )
      await settledSent()

      expect(reparent(oldId).ok).toBe(true)
      await settledSent()

      const views = Object.values(mainWorkspace(TARGET)!.editorViews ?? {})
      expect(views).toEqual([
        expect.objectContaining({
          view: expect.objectContaining({ mode: 'markdown-preview' }),
          file: expect.objectContaining({ filePath: FILE_PATH, relativePath: 'docs/readme.md' })
        })
      ])
      expect(mainWorkspace(SOURCE)?.editorViews ?? {}).toEqual({})
      const preview = useAppStore
        .getState()
        .openFiles.find((file) => file.mode === 'markdown-preview')
      expect(preview).toMatchObject({ worktreeId: TARGET, relativePath: 'docs/readme.md' })
    })

    it('sends nothing when the move fails', async () => {
      const oldId = openRestoredSource()
      useAppStore.getState().openFile(
        {
          filePath: FILE_PATH,
          relativePath: 'docs/readme.md',
          worktreeId: TARGET,
          runtimeEnvironmentId: null,
          language: 'markdown',
          mode: 'edit'
        },
        { suppressActiveRuntimeFallback: true }
      )
      await settledSent()
      expect(reparent(oldId)).toEqual({ ok: false, reason: 'collision' })
      expect(await settledSent()).toEqual([])
    })
  }
)

describe.skipIf(ORCA_LAYOUT_OWNER_IS_MAIN)('restored editor tab moved, switch off', () => {
  it('sends nothing', () => {
    const oldId = openRestoredSource()
    expect(reparent(oldId).ok).toBe(true)
    expect(layoutApplyTestTransport.sent).toEqual([])
  })
})
