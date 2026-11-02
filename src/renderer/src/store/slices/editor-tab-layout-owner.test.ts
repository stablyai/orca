import type { StoreApi } from 'zustand/vanilla'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppState } from '../types'
import { createEditorTabsStore } from './editor-slice-test-harness'
import { makeWorktree } from './worktrees-slice-test-fixtures'
import type { OpenFile } from './editor'
import { restorableEditorFile } from './editor/tabs/editor-tab-layout-owner'
import { buildEditorSessionData } from '@/lib/workspace-session'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host'
import { applyLayoutCommand } from '../../../../shared/workspace-layout/workspace-layout-commands'
import type { LayoutCommand } from '../../../../shared/workspace-layout/workspace-layout-command-types'
import type { WorkspaceLayoutModel } from '../../../../shared/workspace-layout/workspace-layout-model'
import { saveWorkspaceLayout } from '../../../../shared/workspace-layout/workspace-layout-save'
import { asLoaded } from '../../../../shared/workspace-layout/workspace-layout-command.test-fixture'
import { buildPersistedUnifiedTabSessionData } from '@/lib/workspace-session-unified-tabs'
import { loadWorkspaceLayoutWithoutReport } from '../../../../shared/workspace-layout/workspace-layout-load'
import { nameBasedLoadContext } from '../../../../shared/workspace-layout/workspace-layout-minted-ids'
import type { WorkspaceSessionState } from '../../../../shared/workspace-session-state-types'

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

const WT = 'wt-1'

let store: StoreApi<AppState>

/** Main's copy of the same two empty groups the window starts with. */
let main: WorkspaceLayoutModel

beforeEach(() => {
  mocks.layoutOwnerIsMain = true
  mocks.callRuntimeRpc.mockClear()
  store = createEditorTabsStore()
  store.setState({
    groupsByWorktree: {
      [WT]: [
        { id: 'g1', worktreeId: WT, activeTabId: null, tabOrder: [] },
        { id: 'g2', worktreeId: WT, activeTabId: null, tabOrder: [] }
      ]
    },
    activeGroupIdByWorktree: { [WT]: 'g1' },
    unifiedTabsByWorktree: { [WT]: [] }
  })
  main = {
    hostId: LOCAL_EXECUTION_HOST_ID,
    workspaces: {
      [WT]: {
        worktreeId: WT,
        tabs: [],
        groups: [
          { id: 'g1', tabOrder: [] },
          { id: 'g2', tabOrder: [] }
        ]
      }
    },
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
    const applied = applyLayoutCommand(
      main,
      command.type === 'closeTabs' ? { ...command, force: true } : command,
      { mintId: () => `main-${++id}`, mintLeafId: () => `leaf-${++id}`, now: () => 1 }
    )
    if (!applied.ok) {
      throw new Error(`${command.type} refused: ${applied.code}`)
    }
    main = applied.model
  }
  return commands
}

function windowView() {
  const state = store.getState()
  const tabs = state.unifiedTabsByWorktree[WT] ?? []
  return (state.groupsByWorktree[WT] ?? []).map((group) => ({
    group: group.id,
    tabs: group.tabOrder.map((tabId) => {
      const tab = tabs.find((entry) => entry.id === tabId)!
      return {
        id: tab.id,
        entity: tab.entityId,
        preview: tab.isPreview === true,
        createdAt: tab.createdAt
      }
    })
  }))
}

function mainView() {
  const workspace = main.workspaces[WT]!
  return workspace.groups.map((group) => ({
    group: group.id,
    tabs: group.tabOrder.map((tabId) => {
      const tab = workspace.tabs.find((entry) => entry.id === tabId)!
      return {
        id: tab.id,
        entity: tab.entityId,
        preview: tab.isPreview === true,
        createdAt: tab.createdAt
      }
    })
  }))
}

/** Main's tabs by id as loaded from a save, as main's save-divergence check reads them. */
function loadedTabs(session: WorkspaceSessionState) {
  const { layout } = loadWorkspaceLayoutWithoutReport(
    LOCAL_EXECUTION_HOST_ID,
    session,
    nameBasedLoadContext()
  )
  return Object.fromEntries((layout.workspaces[WT]?.tabs ?? []).map((tab) => [tab.id, tab]))
}

/** Main's tabs, then the same after the window's tab-bar save lands on main's session. */
function tabsBeforeAndAfterWindowSave() {
  const mains = saveWorkspaceLayout(asLoaded(main))
  const windows = { ...mains, ...buildPersistedUnifiedTabSessionData(store.getState()) }
  return [loadedTabs(mains), loadedTabs(windows)]
}

function openFile(path: string, options?: { preview?: boolean; targetGroupId?: string }): string {
  return store
    .getState()
    .openFile(
      { filePath: path, relativePath: path.slice(1), worktreeId: WT, language: 'ts', mode: 'edit' },
      options
    )
}

function tabIn(group: string, fileId: string): string {
  const tab = store
    .getState()
    .unifiedTabsByWorktree[WT]!.find(
      (entry) => entry.groupId === group && entry.entityId === fileId
    )
  if (!tab) {
    throw new Error(`no tab for ${fileId} in ${group}`)
  }
  return tab.id
}

describe('editor tabs in a layout-owner build', () => {
  it('sends main the tab the window drew, with its id, group, preview and file', () => {
    const fileId = openFile('/a.ts', { preview: true })

    const [command] = applySent()
    expect(command).toEqual({
      type: 'openEditorTab',
      workspace: WT,
      tabId: tabIn('g1', fileId),
      fileId,
      contentType: 'editor',
      groupId: 'g1',
      preview: true,
      createdAt: windowView()[0]!.tabs[0]!.createdAt,
      file: { filePath: '/a.ts', relativePath: 'a.ts', language: 'ts', runtimeEnvironmentId: null }
    })
    expect(mainView()).toEqual(windowView())
  })

  it('leaves main with the same tabs as the window through preview replacement and pinning', () => {
    openFile('/a.ts', { preview: true })
    const b = openFile('/b.ts', { preview: true })
    applySent()
    // The window replaced a's preview with b's; main replaced it by the same rule.
    expect(mainView()).toEqual(windowView())

    store.getState().activateTab(tabIn('g1', b))
    expect(applySent().map((command) => command.type)).toEqual(['promotePreviewTab'])
    openFile('/c.ts', { preview: true })
    applySent()
    expect(mainView()).toEqual(windowView())

    const c = store.getState().openFiles.find((file) => file.filePath === '/c.ts')!.id
    store.getState().markFileDirty(c, true)
    expect(applySent().map((command) => command.type)).toEqual(['promotePreviewTab'])
    store.getState().markFileDirty(c, true)
    expect(sentCommands()).toEqual([])

    openFile('/d.ts', { preview: true })
    applySent()
    const d = store.getState().openFiles.find((file) => file.filePath === '/d.ts')!.id
    store.getState().makePreviewFilePermanent(d)
    expect(applySent().map((command) => command.type)).toEqual(['promotePreviewTab'])
    openFile('/e.ts', { preview: true })
    applySent()
    expect(mainView()).toEqual(windowView())
    expect(windowView()[0]!.tabs.map((tab) => tab.preview)).toEqual([false, false, false, true])
  })

  it('opens the same file in a second split as a second tab, in main too', () => {
    const a = openFile('/a.ts')
    openFile('/a.ts', { targetGroupId: 'g2' })
    applySent()

    expect(tabIn('g1', a)).not.toBe(tabIn('g2', a))
    expect(mainView()).toEqual(windowView())
    // Opening it again where it already is sends nothing.
    openFile('/a.ts', { targetGroupId: 'g2' })
    expect(sentCommands()).toEqual([])
  })

  it('sends main the file record a reopen in the same tab changed, and nothing when unchanged', () => {
    const log = { filePath: '/a.log', relativePath: 'a.log', worktreeId: WT, language: 'log' }
    const fileId = store
      .getState()
      .openFile({ ...log, mode: 'edit', readOnly: true, liveTail: true }, { preview: false })
    applySent()
    const tabId = tabIn('g1', fileId)
    expect(main.workspaces[WT]!.editorFiles).toEqual([
      expect.objectContaining({ filePath: '/a.log', readOnly: true, liveTail: true })
    ])

    // A normal open of the View Log path makes the same tab writable.
    store.getState().openFile({ ...log, mode: 'edit' })
    const [command, ...rest] = applySent()
    expect(rest).toEqual([])
    expect(command).toMatchObject({ type: 'openEditorTab', tabId, fileId, groupId: 'g1' })
    expect(command?.type === 'openEditorTab' && command.file).toEqual(
      restorableEditorFile(store.getState().openFiles[0]!)
    )
    expect(main.workspaces[WT]!.editorFiles).toEqual([
      { filePath: '/a.log', relativePath: 'a.log', language: 'log', runtimeEnvironmentId: null }
    ])
    expect(mainView()).toEqual(windowView())

    store.getState().openFile({ ...log, mode: 'edit' })
    expect(sentCommands()).toEqual([])
  })

  it('sends main the record a conflict open rewrote in an open tab', () => {
    const fileId = openFile('/repo/a.ts')
    applySent()
    store.getState().openConflictFile(
      WT,
      '/repo',
      {
        path: 'a.ts',
        status: 'modified',
        area: 'unstaged',
        conflictKind: 'both_modified',
        conflictStatus: 'unresolved',
        conflictStatusSource: 'git'
      },
      'typescript'
    )
    expect(applySent()).toEqual([
      expect.objectContaining({
        type: 'openEditorTab',
        tabId: tabIn('g1', fileId),
        file: expect.objectContaining({ relativePath: 'a.ts', language: 'typescript' })
      })
    ])
    expect(main.workspaces[WT]!.editorFiles).toEqual([
      expect.objectContaining({ filePath: '/repo/a.ts', relativePath: 'a.ts' })
    ])
  })

  it('records a close, and a reopen where the window put it back', () => {
    openFile('/a.ts')
    const b = openFile('/b.ts')
    openFile('/c.ts')
    applySent()

    store.getState().closeFile(b)
    expect(applySent()).toEqual([
      { type: 'closeTabs', workspace: WT, tabIds: [expect.any(String)] }
    ])
    expect(mainView()).toEqual(windowView())

    expect(store.getState().reopenClosedEditorTab(WT)).toBe(true)
    expect(applySent().map((command) => command.type)).toEqual(['openEditorTab', 'moveTab'])
    expect(windowView()[0]!.tabs.map((tab) => tab.entity)).toEqual([
      expect.stringContaining('a.ts'),
      b,
      expect.stringContaining('c.ts')
    ])
    expect(mainView()).toEqual(windowView())
  })

  it('sends nothing when a paired server owns the workspace, or with the switch off', () => {
    store.setState({
      worktreesByRepo: {
        'repo-1': [
          makeWorktree({
            id: WT,
            repoId: 'repo-1',
            path: '/repo',
            runtimeOwnerEnvironmentId: 'env-1'
          })
        ]
      }
    })
    openFile('/a.ts', { preview: true })
    expect(sentCommands()).toEqual([])

    mocks.layoutOwnerIsMain = false
    store.setState({
      worktreesByRepo: { 'repo-1': [makeWorktree({ id: WT, repoId: 'repo-1', path: '/repo' })] }
    })
    const b = openFile('/b.ts', { preview: true })
    store.getState().activateTab(tabIn('g1', b))
    store.getState().closeFile(b)
    expect(sentCommands()).toEqual([])
  })

  it('records close-all, and an open into the root group main dropped when it emptied', () => {
    store.setState({
      groupsByWorktree: { [WT]: [{ id: 'g1', worktreeId: WT, activeTabId: null, tabOrder: [] }] }
    })
    main = {
      ...main,
      workspaces: { [WT]: { worktreeId: WT, tabs: [], groups: [{ id: 'g1', tabOrder: [] }] } }
    }
    openFile('/a.ts')
    openFile('/b.ts')
    applySent()

    store.getState().closeAllFiles()
    expect(applySent().map((command) => command.type)).toEqual(['closeTabs', 'closeTabs'])
    // The window keeps its emptied root group; main closed it and takes it back on the next open.
    expect(main.workspaces[WT]!.groups).toEqual([])
    openFile('/c.ts')
    applySent()
    expect(mainView()).toEqual(windowView())
  })

  it('leaves main unchanged rather than misplacing an open into a group it lacks', () => {
    openFile('/a.ts')
    applySent()
    store.setState((state) => ({
      groupsByWorktree: {
        [WT]: [
          ...state.groupsByWorktree[WT]!,
          { id: 'g3', worktreeId: WT, activeTabId: null, tabOrder: [] }
        ]
      }
    }))
    openFile('/b.ts', { targetGroupId: 'g3' })
    const [command] = sentCommands()
    expect(
      applyLayoutCommand(main, command!, { mintId: () => 'x', mintLeafId: () => 'y', now: () => 1 })
    ).toEqual({
      ok: false,
      code: 'group_not_found'
    })
    expect(
      tabIn('g3', store.getState().openFiles.find((file) => file.filePath === '/b.ts')!.id)
    ).toBe(command!.type === 'openEditorTab' ? command.tabId : undefined)
  })

  it('saves the tabs as main holds them, with no preview flag main does not store', () => {
    openFile('/a.ts')
    openFile('/b.ts', { targetGroupId: 'g2' })
    applySent()
    let [was, now] = tabsBeforeAndAfterWindowSave()
    expect(now).toStrictEqual(was)

    const c = openFile('/c.ts', { preview: true })
    store.getState().markFileDirty(c, true)
    const d = openFile('/d.ts', { preview: true, targetGroupId: 'g2' })
    store.getState().makePreviewFilePermanent(d)
    applySent()
    ;[was, now] = tabsBeforeAndAfterWindowSave()
    expect(now).toStrictEqual(was)
  })

  it('pins a preview tab without writing a preview flag', () => {
    const a = openFile('/a.ts', { preview: true })
    store.getState().pinTab(tabIn('g1', a))

    const [tab] = store.getState().unifiedTabsByWorktree[WT]!
    expect(tab?.isPinned).toBe(true)
    expect(tab).not.toHaveProperty('isPreview')
  })

  it('keeps writing the preview flag as false with the switch off', () => {
    mocks.layoutOwnerIsMain = false
    const a = openFile('/a.ts')
    const b = openFile('/b.ts', { preview: true })
    store.getState().pinTab(tabIn('g1', b))

    const tabs = store.getState().unifiedTabsByWorktree[WT]!
    expect(tabs.find((tab) => tab.entityId === a)).toHaveProperty('isPreview', false)
    expect(tabs.find((tab) => tab.entityId === b)).toHaveProperty('isPreview', false)
  })

  it("sends an edit-mode file's record exactly as the window's session save keeps it", () => {
    const file = {
      id: 'f1',
      filePath: '/a.log',
      relativePath: 'a.log',
      worktreeId: WT,
      language: 'log',
      mode: 'edit',
      isDirty: false,
      isPreview: true,
      runtimeEnvironmentId: null,
      externalSshTargetId: 'ssh-1',
      readOnly: true,
      liveTail: true
    } satisfies OpenFile
    const saved = buildEditorSessionData([file], {}, {}, {}, {}).openFilesByWorktree?.[WT]?.[0]
    const { worktreeId: _worktreeId, isPreview: _isPreview, ...restorable } = saved ?? {}
    expect(restorableEditorFile(file)).toEqual(restorable)
  })
})
