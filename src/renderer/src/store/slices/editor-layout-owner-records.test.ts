// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { remapOpenEditorTabsForPathChange } from '@/lib/remap-open-editor-tabs-for-path-change'
import type { AppState } from '@/store/types'
import { endLayoutFramePositions } from '@/runtime/layout-frame-position'
import { openWorkspaceLayoutFrameSync } from '@/runtime/workspace-layout-frame-sync'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host'
import { applyLayoutCommand } from '../../../../shared/workspace-layout/workspace-layout-commands'
import type { LayoutCommand } from '../../../../shared/workspace-layout/workspace-layout-command-types'
import type { WorkspaceLayoutModel } from '../../../../shared/workspace-layout/workspace-layout-model'
import { publishWorkspaceLayout } from '../../../../shared/workspace-layout/workspace-layout-published'
import type { WorkspaceLayoutChangeFrame } from '../../../../shared/workspace-layout/workspace-layout-stream-frames'
import { editorMoveOwnerFromContext, type EditorMoveOwner } from '@/lib/open-editor-move-owner'

const mocks = vi.hoisted(() => ({
  layoutOwnerIsMain: true,
  callRuntimeRpc: vi.fn(
    async (_target: unknown, _method: string, _params: { command: LayoutCommand }) => ({
      ok: true,
      result: {}
    })
  )
}))

const stream = vi.hoisted(
  (): { onFrame: ((frame: WorkspaceLayoutChangeFrame) => void) | null } => ({ onFrame: null })
)

vi.mock('../../../../shared/layout-owner-switch', () => ({
  get ORCA_LAYOUT_OWNER_IS_MAIN() {
    return mocks.layoutOwnerIsMain
  }
}))
vi.mock('@/runtime/runtime-rpc-client', () => ({ callRuntimeRpc: mocks.callRuntimeRpc }))
vi.mock('@/runtime/runtime-layout-client', () => ({
  subscribeRuntimeLayout: (
    _target: unknown,
    _params: unknown,
    onFrame: (frame: WorkspaceLayoutChangeFrame) => void
  ) => {
    stream.onFrame = onFrame
    return { close: () => {} }
  }
}))

const WT = 'repo-a::/repo-a'
const SIBLING = 'repo-a::/repo-a-2'

let main: WorkspaceLayoutModel

beforeEach(() => {
  mocks.layoutOwnerIsMain = true
  mocks.callRuntimeRpc.mockClear()
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
  main = {
    hostId: LOCAL_EXECUTION_HOST_ID,
    workspaces: {},
    records: {},
    legacy: { terminalRowOwners: {} }
  }
})

afterEach(() => endLayoutFramePositions())

function applySent(): LayoutCommand[] {
  const commands = mocks.callRuntimeRpc.mock.calls.map((call) => call[2].command)
  mocks.layoutOwnerIsMain = true
  mocks.callRuntimeRpc.mockClear()
  let id = 0
  for (const command of commands) {
    const applied = applyLayoutCommand(main, command, {
      mintId: () => `main-${++id}`,
      mintLeafId: () => `leaf-${++id}`,
      now: () => 1
    })
    if (!applied.ok) {
      throw new Error(`${command.type} refused: ${applied.code}`)
    }
    main = applied.model
  }
  return commands
}

async function showMainFrame(): Promise<void> {
  // Main has answered the window's commands, so no tab of theirs is still held as drawn.
  await new Promise((resolve) => setTimeout(resolve, 0))
  const sync = openWorkspaceLayoutFrameSync(useAppStore)
  stream.onFrame!({
    type: 'snapshot',
    workspaces: Object.entries(main.workspaces).map(([key, workspace]) => ({
      key,
      layout: publishWorkspaceLayout(workspace, LOCAL_EXECUTION_HOST_ID)
    }))
  })
  sync.start()
  await new Promise((resolve) => setTimeout(resolve, 0))
  sync.close()
}

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
  const workspace = main.workspaces[worktreeId]
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

describe('editor records under frames, layout-owner build', () => {
  it('keeps the file record of every editor tab main keeps', async () => {
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
    applySent()
    const before = editorTabsAndFiles()
    expect(before.every((tab) => tab.hasFile)).toBe(true)

    await showMainFrame()

    expect(editorTabsAndFiles()).toEqual(before)
  })

  it('drops a diff record with the tab main closed, and keeps a record no tab shows', async () => {
    const state = useAppStore.getState()
    state.openDiff(WT, '/repo-a/b.ts', 'b.ts', 'typescript', false)
    applySent()
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
    const closed = applyLayoutCommand(
      main,
      { type: 'closeTabs', workspace: WT, tabIds: [diffTab.id], force: true },
      { mintId: () => 'x', mintLeafId: () => 'y', now: () => 1 }
    )
    if (!closed.ok) {
      throw new Error(closed.code)
    }
    main = closed.model

    await showMainFrame()

    expect(editorTabsAndFiles()).toEqual([])
    expect(useAppStore.getState().openFiles.map((file) => file.id)).toEqual(['/repo-a/c.ts'])
  })
})

describe('open files renamed on disk, layout-owner build', () => {
  it("rekeys main's tabs and file records under the window's ids", async () => {
    const plain = openEdit(WT, '/repo-a/src/a.ts', 'src/a.ts')
    // The same path in a sibling workspace gets an owner-qualified id.
    const owned = openEdit(SIBLING, '/repo-a/src/a.ts', 'src/a.ts')
    useAppStore.getState().openDiff(WT, '/repo-a/src/a.ts', 'src/a.ts', 'typescript', false)
    applySent()
    expect(owned).toMatch(/^editor:/)

    const result = remapOpenEditorTabsForPathChange({
      fromPath: '/repo-a/src',
      toPath: '/repo-a/lib',
      worktreePath: '/repo-a',
      worktreeId: WT,
      owner: localMoveOwner(WT)
    })

    expect(result).toEqual({ ok: true })
    const commands = applySent()
    expect(commands.map((command) => [command.type, command.workspace])).toEqual([
      ['renameEditorFiles', WT],
      ['renameEditorFiles', SIBLING]
    ])
    expect(editorTabsAndFiles().map((tab) => tab.entity)).not.toContain(plain)
    for (const worktreeId of [WT, SIBLING]) {
      expect(mainView(worktreeId)).toEqual(windowView(worktreeId))
      expect(main.workspaces[worktreeId]!.editorFiles).toEqual([
        expect.objectContaining({ filePath: '/repo-a/lib/a.ts', relativePath: 'lib/a.ts' })
      ])
    }

    const before = [editorTabsAndFiles(WT), editorTabsAndFiles(SIBLING)]
    await showMainFrame()
    expect([editorTabsAndFiles(WT), editorTabsAndFiles(SIBLING)]).toEqual(before)
  })

  it('sends nothing for a refused rekey or with the switch off', () => {
    openEdit(WT, '/repo-a/a.ts', 'a.ts')
    openEdit(WT, '/repo-a/b.ts', 'b.ts')
    applySent()
    expect(
      remapOpenEditorTabsForPathChange({
        fromPath: '/repo-a/a.ts',
        toPath: '/repo-a/b.ts',
        worktreePath: '/repo-a',
        worktreeId: WT,
        owner: localMoveOwner(WT)
      })
    ).toEqual({ ok: false, reason: 'collision' })
    expect(applySent()).toEqual([])

    mocks.layoutOwnerIsMain = false
    expect(
      remapOpenEditorTabsForPathChange({
        fromPath: '/repo-a/a.ts',
        toPath: '/repo-a/c.ts',
        worktreePath: '/repo-a',
        worktreeId: WT,
        owner: localMoveOwner(WT)
      })
    ).toEqual({ ok: true })
    expect(applySent()).toEqual([])
  })
})

describe('a resolved deleted-side conflict, layout-owner build', () => {
  it("closes the placeholder's tab in main, so no frame brings its record back", async () => {
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
    applySent()
    expect(editorTabsAndFiles()).toEqual([
      { kind: 'editor', entity: '/repo-a/gone.ts', hasFile: true }
    ])
    expect(main.workspaces[WT]!.tabs).toHaveLength(1)

    useAppStore.getState().setGitStatus(WT, { entries: [], conflictOperation: 'merge' })

    expect(applySent().map((command) => command.type)).toEqual(['closeTabs'])
    expect(main.workspaces[WT]!.tabs).toEqual([])
    await showMainFrame()
    expect(editorTabsAndFiles()).toEqual([])
    expect(useAppStore.getState().openFiles).toEqual([])
  })
})
