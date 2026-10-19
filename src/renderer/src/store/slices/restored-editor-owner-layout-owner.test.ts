// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { captureEditorFileOperationProvenance } from '@/lib/editor-file-operation-owner'
import type { AppState } from '@/store/types'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host'
import { applyLayoutCommand } from '../../../../shared/workspace-layout/workspace-layout-commands'
import type { LayoutCommand } from '../../../../shared/workspace-layout/workspace-layout-command-types'
import type { WorkspaceLayoutModel } from '../../../../shared/workspace-layout/workspace-layout-model'

const mocks = vi.hoisted(() => ({
  layoutOwnerIsMain: true,
  callRuntimeRpc: vi.fn(
    async (_target: unknown, _method: string, _params: { command: LayoutCommand }) => ({
      ok: true,
      result: {}
    })
  )
}))

vi.mock('../../../../shared/layout-owner-switch', () => ({
  get ORCA_LAYOUT_OWNER_IS_MAIN() {
    return mocks.layoutOwnerIsMain
  }
}))
vi.mock('@/runtime/runtime-rpc-client', () => ({ callRuntimeRpc: mocks.callRuntimeRpc }))

const SOURCE = 'repo-a::/repo-a'
const TARGET = 'repo-b::/repo-b'
const FILE_PATH = '/repo-b/docs/readme.md'

let main: WorkspaceLayoutModel

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

beforeEach(() => {
  mocks.layoutOwnerIsMain = true
  mocks.callRuntimeRpc.mockClear()
  installWorkspaceState()
  main = {
    hostId: LOCAL_EXECUTION_HOST_ID,
    workspaces: {},
    records: {},
    legacy: { terminalRowOwners: {} }
  }
})

function sentCommands(): LayoutCommand[] {
  const commands = mocks.callRuntimeRpc.mock.calls.map((call) => call[2].command)
  mocks.callRuntimeRpc.mockClear()
  return commands
}

/** Applies what the window sent to main's copy, as `layout.apply` does. */
function applySent(): LayoutCommand[] {
  const commands = sentCommands()
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

describe('restored editor tab moved to its owning workspace, layout-owner build', () => {
  it('records the move under the ids and group the window chose', () => {
    const oldId = openRestoredSource()
    applySent()
    expectMainMatchesWindow()

    const result = reparent(oldId)

    expect(result.ok).toBe(true)
    const [command] = applySent()
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
    expect(main.workspaces[TARGET]!.editorFiles).toEqual([
      expect.objectContaining({ filePath: FILE_PATH, relativePath: 'docs/readme.md' })
    ])
    expect(main.workspaces[SOURCE]!.editorFiles).toEqual([])
  })

  it("appends to the target's active group after its own tabs, with a dependent preview", () => {
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
    applySent()
    expectMainMatchesWindow()
    expect(windowView(SOURCE)[0]!.tabs).toHaveLength(2)

    expect(reparent(oldId).ok).toBe(true)

    const [command] = applySent()
    expect(command).toMatchObject({ type: 'moveTabToWorkspace' })
    expect(command!.type === 'moveTabToWorkspace' && command.tabs).toHaveLength(2)
    expect(windowView(TARGET)[0]!.tabs).toHaveLength(3)
    expectMainMatchesWindow()
  })

  it('records a re-own inside the same local workspace as a rename with its new record', () => {
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
    applySent()
    expectMainMatchesWindow()

    const result = reparent(oldId, SOURCE, 'notes.md')

    expect(result).toMatchObject({ ok: true })
    const [command] = applySent()
    expect(command).toMatchObject({ type: 'renameEditorFiles', workspace: SOURCE })
    expectMainMatchesWindow()
    expect(main.workspaces[SOURCE]!.editorFiles).toEqual([
      expect.objectContaining({ filePath: inSourcePath, relativePath: 'notes.md' })
    ])
  })

  it('sends nothing when the move fails or the switch is off', () => {
    const oldId = openRestoredSource()
    applySent()
    const collidingId = useAppStore.getState().openFile(
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
    applySent()
    expect(reparent(oldId)).toEqual({ ok: false, reason: 'collision' })
    expect(sentCommands()).toEqual([])
    useAppStore.getState().closeFile(collidingId)
    sentCommands()

    mocks.layoutOwnerIsMain = false
    expect(reparent(oldId).ok).toBe(true)
    expect(sentCommands()).toEqual([])
  })
})
