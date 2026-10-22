// @vitest-environment happy-dom

// Editor records in a layout-owner build (ORCA_LAYOUT_OWNER=main): main's frames draw the editor
// tabs, and a diff, preview or conflict tab is drawn from the view its open sent.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { remapOpenEditorTabsForPathChange } from '@/lib/remap-open-editor-tabs-for-path-change'
import type { AppState } from '@/store/types'
import type { LayoutCommand } from '../../../../shared/workspace-layout/workspace-layout-command-types'
import { layoutApplyTestTransport } from '@/runtime/layout-apply-test-transport.test-fixture'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../shared/layout-owner-switch'
import { editorMoveOwnerFromContext, type EditorMoveOwner } from '@/lib/open-editor-move-owner'
import { drawTabsFromMain, type TabsDrawnFromMain } from './tabs-drawn-from-main.test-fixture'
import { contentRekeyOutcome } from '@/runtime/layout-owner-content-rekeys'
import { hasPendingEntityTab } from '@/runtime/layout-owner-pending-tabs'

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

function editorTabsAndFiles(worktreeId = WT) {
  const state = useAppStore.getState()
  const fileIds = new Set(state.openFiles.map((file) => file.id))
  return (state.unifiedTabsByWorktree[worktreeId] ?? []).map((tab) => ({
    kind: tab.contentType,
    entity: tab.entityId,
    hasFile: fileIds.has(tab.entityId)
  }))
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

function mainView(worktreeId: string) {
  const workspace = layoutApplyTestTransport.mainModel!.workspaces[worktreeId]
  return (workspace?.groups ?? []).map((group) => ({
    group: group.id,
    tabs: group.tabOrder.map((tabId) => {
      const tab = workspace!.tabs.find((entry) => entry.id === tabId)!
      return { id: tab.id, entity: tab.entityId }
    })
  }))
}

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

describe.runIf(ORCA_LAYOUT_OWNER_IS_MAIN)('editor records under frames, layout-owner build', () => {
  it('draws every editor tab main keeps, each with its file record', async () => {
    const state = useAppStore.getState()
    state.openFile(
      {
        filePath: '/repo-a/a.md',
        relativePath: 'a.md',
        worktreeId: WT,
        runtimeEnvironmentId: null,
        language: 'markdown',
        mode: 'edit'
      },
      { suppressActiveRuntimeFallback: true }
    )
    state.openDiff(WT, '/repo-a/b.ts', 'b.ts', 'typescript', false)
    state.openMarkdownPreview({
      filePath: '/repo-a/a.md',
      relativePath: 'a.md',
      worktreeId: WT,
      runtimeEnvironmentId: null,
      language: 'markdown'
    })
    await main.settle()

    expect(editorTabsAndFiles()).toEqual([
      { kind: 'editor', entity: '/repo-a/a.md', hasFile: true },
      { kind: 'diff', entity: expect.any(String), hasFile: true },
      { kind: 'editor', entity: expect.any(String), hasFile: true }
    ])
    // A diff or preview is kept by the view its open sent, not by the window's record.
    expect(
      layoutApplyTestTransport
        .sentOfType('openEditorTab')
        .map((command) => [command.contentType, command.view?.view.mode ?? null])
    ).toEqual([
      ['editor', null],
      ['diff', 'diff'],
      ['editor', 'markdown-preview']
    ])
  })

  it('drops a diff record with the tab main closed, and keeps a record no tab shows', async () => {
    useAppStore.getState().openDiff(WT, '/repo-a/b.ts', 'b.ts', 'typescript', false)
    await main.settle()
    const diffTab = useAppStore.getState().unifiedTabsByWorktree[WT]![0]!
    // A conflict review's selected file has no tab of its own.
    useAppStore.setState({
      openFiles: [
        ...useAppStore.getState().openFiles,
        {
          id: '/repo-a/c.ts',
          filePath: '/repo-a/c.ts',
          relativePath: 'c.ts',
          worktreeId: WT,
          language: 'typescript',
          isDirty: false,
          mode: 'edit'
        }
      ]
    })
    // Main closes the diff tab (another client's close).
    await layoutApplyTestTransport.call({
      command: { type: 'closeTabs', workspace: WT, tabIds: [diffTab.id], force: true }
    })
    await main.settle()

    expect(editorTabsAndFiles()).toEqual([])
    expect(useAppStore.getState().openFiles.map((file) => file.id)).toEqual(['/repo-a/c.ts'])
  })
})

describe.runIf(ORCA_LAYOUT_OWNER_IS_MAIN)('tabs only a frame drew, layout-owner build', () => {
  it("labels them as the window's own open would, from the file", async () => {
    openEdit(WT, '/repo-a/own.ts', 'own.ts')
    await main.settle()
    // Another client's opens: this window never opened either tab.
    for (const command of [
      {
        type: 'openEditorTab',
        workspace: WT,
        tabId: 'other-edit',
        fileId: '/repo-a/x.md',
        contentType: 'editor',
        file: { filePath: '/repo-a/x.md', relativePath: 'x.md', language: 'markdown' }
      },
      {
        type: 'openEditorTab',
        workspace: WT,
        tabId: 'other-preview',
        fileId: 'markdown-preview::/repo-a/x.md',
        contentType: 'editor',
        view: {
          view: { mode: 'markdown-preview', markdownPreviewSourceFileId: '/repo-a/x.md' },
          file: { filePath: '/repo-a/x.md', relativePath: 'x.md', language: 'markdown' }
        }
      }
    ]) {
      await layoutApplyTestTransport.call({ command })
    }
    await main.settle()

    expect(
      (useAppStore.getState().unifiedTabsByWorktree[WT] ?? []).map((tab) => [tab.id, tab.label])
    ).toEqual([
      [expect.any(String), 'own.ts'],
      ['other-edit', 'x.md'],
      ['other-preview', 'x.md (preview)']
    ])
  })
})

describe.runIf(ORCA_LAYOUT_OWNER_IS_MAIN)('closing every editor, layout-owner build', () => {
  it("keeps the files' content until main's frame drops their tabs", async () => {
    const a = openEdit(WT, '/repo-a/a.ts', 'a.ts')
    openEdit(WT, '/repo-a/b.ts', 'b.ts')
    await main.settle()
    useAppStore.getState().setEditorDraft(a, 'unsaved')

    useAppStore.getState().closeAllFiles()

    expect(useAppStore.getState().openFiles.map((file) => file.id)).toEqual([a, '/repo-a/b.ts'])
    expect(useAppStore.getState().editorDrafts).toEqual({ [a]: 'unsaved' })
    await main.settle()
    const state = useAppStore.getState()
    expect(editorTabsAndFiles()).toEqual([])
    expect(state.openFiles).toEqual([])
    expect(state.editorDrafts).toEqual({})
    expect(state.recentlyClosedEditorTabsByWorktree[WT]?.map((entry) => entry.filePath)).toEqual([
      '/repo-a/a.ts',
      '/repo-a/b.ts'
    ])
  })

  it('cleans a file up once when it is closed again while its close is in flight', async () => {
    const a = openEdit(WT, '/repo-a/a.ts', 'a.ts')
    await main.settle()
    useAppStore.getState().setEditorDraft(a, 'unsaved')
    // A repeat close reaches main after the first emptied the workspace, which main refuses.
    let closes = 0
    layoutApplyTestTransport.answerWith(() =>
      closes++ === 0 ? 'pending' : { ok: false, code: 'workspace_not_found' }
    )

    useAppStore.getState().closeFile(a)
    useAppStore.getState().closeFile(a)
    await main.settle()
    layoutApplyTestTransport.answerWith('apply')
    layoutApplyTestTransport.answerPending()
    await main.settle()

    const state = useAppStore.getState()
    expect(editorTabsAndFiles()).toEqual([])
    expect(state.openFiles).toEqual([])
    expect(state.editorDrafts).toEqual({})
    expect(state.recentlyClosedEditorTabsByWorktree[WT]?.map((entry) => entry.filePath)).toEqual([
      '/repo-a/a.ts'
    ])
    expect(layoutApplyTestTransport.sentOfType('closeTabs')).toHaveLength(1)
  })

  it("cleans a file up when it is closed during a bulk close's close of its tab", async () => {
    const keep = openEdit(WT, '/repo-a/keep.ts', 'keep.ts')
    const a = openEdit(WT, '/repo-a/a.ts', 'a.ts')
    await main.settle()
    useAppStore.getState().setEditorDraft(a, 'unsaved')
    const keepTab = useAppStore
      .getState()
      .unifiedTabsByWorktree[WT]?.find((tab) => tab.entityId === keep)
    layoutApplyTestTransport.answerWith('pending')

    // "Close others" closes a's tab with no file cleanup; a closeFile lands while it is in flight.
    useAppStore.getState().closeOtherTabs(keepTab?.id ?? '')
    useAppStore.getState().closeFile(a)
    layoutApplyTestTransport.answerWith('apply')
    layoutApplyTestTransport.answerPending()
    await main.settle()

    const state = useAppStore.getState()
    expect(editorTabsAndFiles().map((tab) => tab.entity)).toEqual([keep])
    expect(state.openFiles.map((file) => file.id)).toEqual([keep])
    expect(state.editorDrafts).toEqual({})
    expect(layoutApplyTestTransport.sentOfType('closeTabs')).toHaveLength(1)
  })

  it('settles an open whose selection threw: its waiters run and nothing stays pending', async () => {
    const activateTab = useAppStore.getState().activateTab
    useAppStore.setState({
      activateTab: () => {
        throw new Error('selection failed')
      }
    })
    const shown: unknown[] = []
    useAppStore.getState().openFileForLink(
      {
        filePath: '/repo-a/a.ts',
        relativePath: 'a.ts',
        worktreeId: WT,
        runtimeEnvironmentId: null,
        language: 'typescript',
        mode: 'edit'
      },
      undefined,
      null,
      (result) => shown.push(result)
    )
    await main.settle()
    useAppStore.setState({ activateTab })

    expect(shown).toEqual([expect.objectContaining({ fileId: '/repo-a/a.ts' })])
    expect(hasPendingEntityTab(WT, '/repo-a/a.ts')).toBe(false)
  })

  it('keeps every file whose close main refused', async () => {
    const a = openEdit(WT, '/repo-a/a.ts', 'a.ts')
    await main.settle()
    useAppStore.getState().setEditorDraft(a, 'unsaved')
    layoutApplyTestTransport.answerWith({ refuse: 'tab_not_found' })

    useAppStore.getState().closeAllFiles()
    await main.settle()

    expect(editorTabsAndFiles()).toEqual([{ kind: 'editor', entity: a, hasFile: true }])
    expect(useAppStore.getState().editorDrafts).toEqual({ [a]: 'unsaved' })
  })
})

describe.runIf(ORCA_LAYOUT_OWNER_IS_MAIN)('open files renamed on disk, layout-owner build', () => {
  it("rekeys main's tabs and file records under the window's ids", async () => {
    const plain = openEdit(WT, '/repo-a/src/a.ts', 'src/a.ts')
    // The same path in a sibling workspace gets an owner-qualified id.
    const owned = openEdit(SIBLING, '/repo-a/src/a.ts', 'src/a.ts')
    useAppStore.getState().openDiff(WT, '/repo-a/src/a.ts', 'src/a.ts', 'typescript', false)
    await main.settle()
    expect(owned).toMatch(/^editor:/)
    const sentBefore = layoutApplyTestTransport.sent.length

    const result = remapOpenEditorTabsForPathChange({
      fromPath: '/repo-a/src',
      toPath: '/repo-a/lib',
      worktreePath: '/repo-a',
      worktreeId: WT,
      owner: localMoveOwner(WT)
    })

    expect(result).toEqual({ ok: true })
    await main.settle()
    const commands = layoutApplyTestTransport.sent.slice(sentBefore)
    // One command: main renames both workspaces' tabs or neither.
    expect(
      commands.map((command) => [
        command.type,
        command.workspace,
        command.type === 'renameEditorFiles' ? command.alsoIn?.map((entry) => entry.workspace) : []
      ])
    ).toEqual([['renameEditorFiles', WT, [SIBLING]]])
    expect(editorTabsAndFiles().map((tab) => tab.entity)).not.toContain(plain)
    for (const worktreeId of [WT, SIBLING]) {
      expect(mainView(worktreeId)).toEqual(windowView(worktreeId))
      expect(layoutApplyTestTransport.mainModel!.workspaces[worktreeId]!.editorFiles).toEqual([
        expect.objectContaining({ filePath: '/repo-a/lib/a.ts', relativePath: 'lib/a.ts' })
      ])
    }
    expect(editorTabsAndFiles(WT).every((tab) => tab.hasFile)).toBe(true)
    expect(editorTabsAndFiles(SIBLING).every((tab) => tab.hasFile)).toBe(true)
  })

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

  it('changes nothing when main refuses the rename', async () => {
    const oldId = openEdit(WT, '/repo-a/src/a.ts', 'src/a.ts')
    await main.settle()
    useAppStore.getState().setEditorDraft(oldId, 'unsaved')
    const before = useAppStore.getState()
    layoutApplyTestTransport.answerWith({ refuse: 'invalid_params' })

    remapOpenEditorTabsForPathChange({
      fromPath: '/repo-a/src',
      toPath: '/repo-a/lib',
      worktreePath: '/repo-a',
      worktreeId: WT,
      owner: localMoveOwner(WT),
      moveOperationId: 'move-1'
    })

    expect(await contentRekeyOutcome([oldId])).toBe(false)
    await main.settle()
    const after = useAppStore.getState()
    expect(after.openFiles).toEqual(before.openFiles)
    expect(after.editorDrafts).toEqual({ [oldId]: 'unsaved' })
    expect(after.unifiedTabsByWorktree).toEqual(before.unifiedTabsByWorktree)
  })

  it('settles a rename whose content rekey threw, so the move does not wait forever', async () => {
    openEdit(WT, '/repo-a/b.ts', 'b.ts')
    await main.settle()
    // A conflict review's selected file has no tab: main's answer rekeys it.
    useAppStore.setState({
      openFiles: [
        ...useAppStore.getState().openFiles,
        {
          id: '/repo-a/src/c.ts',
          filePath: '/repo-a/src/c.ts',
          relativePath: 'src/c.ts',
          worktreeId: WT,
          language: 'typescript',
          isDirty: false,
          mode: 'edit'
        }
      ]
    })
    const unsubscribe = useAppStore.subscribe((state) => {
      if (state.openFiles.some((file) => file.filePath === '/repo-a/lib/c.ts')) {
        throw new Error('a subscriber threw')
      }
    })
    remapOpenEditorTabsForPathChange({
      fromPath: '/repo-a/src',
      toPath: '/repo-a/lib',
      worktreePath: '/repo-a',
      worktreeId: WT,
      owner: localMoveOwner(WT)
    })
    const outcomes: boolean[] = []
    void contentRekeyOutcome(['/repo-a/src/c.ts']).then((ok) => outcomes.push(ok))

    await main.settle()
    unsubscribe()

    expect(outcomes).toEqual([false])
  })

  it("gives a renamed view tab's published view the file's new path", async () => {
    useAppStore.getState().openDiff(WT, '/repo-a/src/a.ts', 'src/a.ts', 'typescript', false)
    await main.settle()

    remapOpenEditorTabsForPathChange({
      fromPath: '/repo-a/src',
      toPath: '/repo-a/lib',
      worktreePath: '/repo-a',
      worktreeId: WT,
      owner: localMoveOwner(WT)
    })
    await main.settle()

    const views = Object.values(layoutApplyTestTransport.mainModel!.workspaces[WT]!.editorViews!)
    expect(views).toEqual([
      expect.objectContaining({
        file: expect.objectContaining({ filePath: '/repo-a/lib/a.ts', relativePath: 'lib/a.ts' })
      })
    ])
    expect(editorTabsAndFiles()).toEqual([
      { kind: 'diff', entity: expect.stringContaining('lib/a.ts'), hasFile: true }
    ])
  })

  it('sends nothing for a refused rekey', async () => {
    openEdit(WT, '/repo-a/a.ts', 'a.ts')
    openEdit(WT, '/repo-a/b.ts', 'b.ts')
    await main.settle()
    const sentBefore = layoutApplyTestTransport.sent.length
    expect(
      remapOpenEditorTabsForPathChange({
        fromPath: '/repo-a/a.ts',
        toPath: '/repo-a/b.ts',
        worktreePath: '/repo-a',
        worktreeId: WT,
        owner: localMoveOwner(WT)
      })
    ).toEqual({ ok: false, reason: 'collision' })
    expect(layoutApplyTestTransport.sent.slice(sentBefore)).toEqual([])
  })
})

describe.skipIf(ORCA_LAYOUT_OWNER_IS_MAIN)('open files renamed on disk, switch off', () => {
  it('sends nothing', () => {
    openEdit(WT, '/repo-a/a.ts', 'a.ts')
    expect(
      remapOpenEditorTabsForPathChange({
        fromPath: '/repo-a/a.ts',
        toPath: '/repo-a/c.ts',
        worktreePath: '/repo-a',
        worktreeId: WT,
        owner: localMoveOwner(WT)
      })
    ).toEqual({ ok: true })
    expect(layoutApplyTestTransport.sent).toEqual([])
  })
})

describe.runIf(ORCA_LAYOUT_OWNER_IS_MAIN)(
  'a resolved deleted-side conflict, layout-owner build',
  () => {
    it("closes the placeholder's tab in main, and the frame drops it", async () => {
      const entry = {
        path: 'gone.ts',
        status: 'deleted' as const,
        area: 'unstaged' as const,
        conflictKind: 'deleted_by_us' as const,
        conflictStatus: 'unresolved' as const,
        conflictStatusSource: 'git' as const
      }
      useAppStore.getState().setGitStatus(WT, { entries: [entry], conflictOperation: 'merge' })
      useAppStore.getState().openConflictFile(WT, '/repo-a', entry, 'typescript')
      await main.settle()
      expect(editorTabsAndFiles()).toEqual([
        { kind: 'editor', entity: '/repo-a/gone.ts', hasFile: true }
      ])
      expect(layoutApplyTestTransport.mainModel!.workspaces[WT]!.tabs).toHaveLength(1)
      const sentBefore = layoutApplyTestTransport.sent.length

      useAppStore.getState().setGitStatus(WT, { entries: [], conflictOperation: 'merge' })
      expect(
        layoutApplyTestTransport.sent.slice(sentBefore).map((command) => command.type)
      ).toEqual(['closeTabs'])
      await main.settle()
      expect(layoutApplyTestTransport.mainModel!.workspaces[WT]?.tabs ?? []).toEqual([])
      expect(editorTabsAndFiles()).toEqual([])
      expect(useAppStore.getState().openFiles).toEqual([])
    })
  }
)

describe.runIf(ORCA_LAYOUT_OWNER_IS_MAIN)(
  'a runtime-owned file the window opens, layout-owner build',
  () => {
    const FILE = '/repo-a/src/remote.ts'
    const openRuntimeOwned = (onShown: (result: unknown) => void) =>
      useAppStore.getState().openFileForLink(
        {
          filePath: FILE,
          relativePath: 'src/remote.ts',
          worktreeId: WT,
          runtimeEnvironmentId: 'env-1',
          language: 'typescript',
          mode: 'edit'
        },
        undefined,
        null,
        onShown
      )

    it('keeps one id through frames, so its reveal runs and a rename reaches main', async () => {
      const shown: unknown[] = []
      openRuntimeOwned((result) => shown.push(result))
      await main.settle()

      const fileId = useAppStore.getState().openFiles[0]?.id
      expect(shown).toEqual([expect.objectContaining({ fileId })])
      expect(editorTabsAndFiles()).toEqual([{ kind: 'editor', entity: fileId, hasFile: true }])
      expect(mainView(WT)).toEqual(windowView(WT))

      remapOpenEditorTabsForPathChange({
        fromPath: '/repo-a/src',
        toPath: '/repo-a/lib',
        worktreePath: '/repo-a',
        worktreeId: WT,
        owner: editorMoveOwnerFromContext(
          { target: { kind: 'environment', environmentId: 'env-1' } },
          WT
        )
      })
      expect(await contentRekeyOutcome([fileId ?? ''])).toBe(true)
      await main.settle()
      expect(layoutApplyTestTransport.mainModel?.workspaces[WT]?.editorFiles).toEqual([
        expect.objectContaining({ filePath: '/repo-a/lib/remote.ts' })
      ])
      expect(mainView(WT)).toEqual(windowView(WT))
      expect(editorTabsAndFiles()).toEqual([
        { kind: 'editor', entity: expect.stringContaining('remote.ts'), hasFile: true }
      ])
    })
  }
)
