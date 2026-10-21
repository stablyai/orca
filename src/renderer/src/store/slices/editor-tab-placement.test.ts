import type { StoreApi } from 'zustand/vanilla'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createEditorStore,
  createEditorTabsStore,
  ownedEditorFileId
} from './editor-slice-test-harness'
import type { AppState } from '../types'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../shared/constants'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../shared/layout-owner-switch'
import { layoutApplyTestTransport } from '@/runtime/layout-apply-test-transport.test-fixture'
import { makeLayout, makeTab } from './store-test-helpers'
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

const { toastErrorMock } = vi.hoisted(() => ({
  toastErrorMock: vi.fn()
}))

vi.mock('sonner', () => ({
  toast: { error: toastErrorMock }
}))

const { notifyHostOfMirroredEditorCloseMock } = vi.hoisted(() => ({
  notifyHostOfMirroredEditorCloseMock: vi.fn()
}))
vi.mock('@/runtime/close-mirrored-editor-tab', () => ({
  notifyHostOfMirroredEditorClose: (...args: unknown[]) =>
    notifyHostOfMirroredEditorCloseMock(...args)
}))

let main: TabsDrawnFromMain = { settle: async () => {}, close: () => {} }
afterEach(() => {
  main.close()
  main = { settle: async () => {}, close: () => {} }
})

/** An editor-tabs store main draws from; its session read-back needs these maps. */
function createDrawnEditorTabsStore(): StoreApi<AppState> {
  const store = createEditorTabsStore()
  store.setState({ ptyIdsByTabId: {}, lastKnownRelayPtyIdByTabId: {} })
  return store
}

function fileIdOf(store: { getState: () => AppState }, filePath: string): string | undefined {
  return store.getState().openFiles.find((file) => file.filePath === filePath)?.id
}

/** A floating file's id: its path, or an owned id when main owns the layout. */
function expectedFileId(filePath: string): unknown {
  return ORCA_LAYOUT_OWNER_IS_MAIN
    ? ownedEditorFileId(filePath, FLOATING_TERMINAL_WORKTREE_ID, null)
    : filePath
}

describe('createEditorSlice floating editor activation', () => {
  it('creates a visible floating editor tab when the floating workspace is empty', async () => {
    const store = createDrawnEditorTabsStore()
    main = await drawTabsFromMain(store)

    store.getState().openFile(
      {
        filePath: '/tmp/orca/notes.md',
        relativePath: 'notes.md',
        worktreeId: FLOATING_TERMINAL_WORKTREE_ID,
        runtimeEnvironmentId: null,
        language: 'markdown',
        mode: 'edit'
      },
      { suppressActiveRuntimeFallback: true }
    )
    // A layout-owner build draws and selects the tab once main's frame is in.
    await main.settle()

    const fileId = fileIdOf(store, '/tmp/orca/notes.md')
    expect(fileId).toEqual(expectedFileId('/tmp/orca/notes.md'))
    const tab = store.getState().unifiedTabsByWorktree[FLOATING_TERMINAL_WORKTREE_ID]?.[0]
    expect(tab).toMatchObject({
      contentType: 'editor',
      entityId: fileId,
      // Main publishes no editor label; the tab bar names an editor tab by its file.
      ...(ORCA_LAYOUT_OWNER_IS_MAIN ? {} : { label: 'notes.md' }),
      worktreeId: FLOATING_TERMINAL_WORKTREE_ID
    })
    expect(store.getState().groupsByWorktree[FLOATING_TERMINAL_WORKTREE_ID]?.[0]).toMatchObject({
      activeTabId: tab?.id,
      tabOrder: [tab?.id]
    })
    expect(store.getState().activeFileIdByWorktree[FLOATING_TERMINAL_WORKTREE_ID]).toBe(fileId)
  })

  it('opens floating markdown tabs without changing the main active editor surface', () => {
    const store = createEditorStore()
    store.setState({
      activeFileId: '/repo/main.md',
      activeTabType: 'editor',
      activeFileIdByWorktree: { 'wt-1': '/repo/main.md' },
      activeTabTypeByWorktree: { 'wt-1': 'editor' }
    } as Partial<AppState>)

    store.getState().openFile({
      filePath: '/tmp/orca/untitled.md',
      relativePath: 'untitled.md',
      worktreeId: FLOATING_TERMINAL_WORKTREE_ID,
      language: 'markdown',
      isUntitled: true,
      mode: 'edit'
    })

    expect(store.getState().activeFileId).toBe('/repo/main.md')
    expect(store.getState().activeTabType).toBe('editor')
    expect(store.getState().activeFileIdByWorktree[FLOATING_TERMINAL_WORKTREE_ID]).toEqual(
      expectedFileId('/tmp/orca/untitled.md')
    )
    expect(store.getState().activeTabTypeByWorktree[FLOATING_TERMINAL_WORKTREE_ID]).toBe('editor')
  })

  it('opens same-path floating markdown as a separate owner-qualified tab', () => {
    const store = createEditorStore()
    store.setState({
      openFiles: [
        {
          id: '/repo/README.md',
          filePath: '/repo/README.md',
          relativePath: 'README.md',
          worktreeId: 'wt-1',
          language: 'markdown',
          isDirty: false,
          mode: 'edit'
        }
      ],
      activeFileIdByWorktree: { 'wt-1': '/repo/README.md' },
      activeTabTypeByWorktree: { 'wt-1': 'editor' }
    } as Partial<AppState>)

    store.getState().openFile(
      {
        filePath: '/repo/README.md',
        relativePath: 'README.md',
        worktreeId: FLOATING_TERMINAL_WORKTREE_ID,
        runtimeEnvironmentId: null,
        language: 'markdown',
        mode: 'edit'
      },
      { suppressActiveRuntimeFallback: true }
    )

    expect(store.getState().openFiles).toHaveLength(2)
    expect(store.getState().openFiles[0]).toMatchObject({
      filePath: '/repo/README.md',
      worktreeId: 'wt-1'
    })
    expect(store.getState().openFiles[1]).toMatchObject({
      filePath: '/repo/README.md',
      worktreeId: FLOATING_TERMINAL_WORKTREE_ID,
      runtimeEnvironmentId: null
    })
    expect(store.getState().openFiles[1]?.id).not.toBe('/repo/README.md')
    expect(store.getState().activeFileIdByWorktree[FLOATING_TERMINAL_WORKTREE_ID]).toBe(
      store.getState().openFiles[1]?.id
    )
  })
})

describe('createEditorSlice split-group editor routing', () => {
  function openSourceFile(
    store: StoreApi<AppState>,
    filePath: string,
    options?: Parameters<AppState['openFile']>[1]
  ): void {
    store.getState().openFile(
      {
        filePath,
        relativePath: filePath.replace('/repo/', ''),
        worktreeId: 'wt-1',
        language: 'typescript',
        mode: 'edit'
      },
      options
    )
  }

  async function seedTerminalAndEditorGroups(store: StoreApi<AppState>): Promise<{
    terminalTabId: string
    terminalGroupId: string
    editorGroupId: string
  }> {
    // The terminal's row, so main holds the agent tab and its group.
    store.setState({
      tabsByWorktree: { 'wt-1': [makeTab({ id: 'terminal-tab', worktreeId: 'wt-1' })] },
      terminalLayoutsByTabId: { 'terminal-tab': makeLayout() }
    })
    const terminalTab = store.getState().createUnifiedTab('wt-1', 'terminal', {
      id: 'terminal-tab',
      entityId: 'terminal-tab',
      label: 'Agent'
    })
    main = await drawTabsFromMain(store)
    const terminalGroup = store.getState().groupsByWorktree['wt-1']?.[0]
    if (!terminalGroup) {
      throw new Error('Expected terminal group')
    }
    const terminalGroupId = terminalGroup.id
    const editorGroupId = store.getState().createEmptySplitGroup('wt-1', terminalGroupId, 'right')
    if (!editorGroupId) {
      throw new Error('Expected split editor group')
    }
    openSourceFile(store, '/repo/seed.ts', { targetGroupId: editorGroupId })
    await main.settle()
    store.setState({
      activeGroupIdByWorktree: { 'wt-1': terminalGroupId },
      activeTabType: 'terminal',
      activeTabTypeByWorktree: { 'wt-1': 'terminal' }
    } as Partial<AppState>)
    return { terminalTabId: terminalTab.id, terminalGroupId, editorGroupId }
  }

  function findUnifiedTabByEntity(store: StoreApi<AppState>, entityId: string) {
    return store.getState().unifiedTabsByWorktree['wt-1']?.find((tab) => tab.entityId === entityId)
  }

  /** The group an open put the file in: a layout-owner build names it in main's open command. */
  function openedGroupOf(store: StoreApi<AppState>, entityId: string): string | undefined {
    return ORCA_LAYOUT_OWNER_IS_MAIN
      ? layoutApplyTestTransport
          .sentOfType('openEditorTab')
          .find((command) => command.fileId === entityId)?.groupId
      : findUnifiedTabByEntity(store, entityId)?.groupId
  }

  it('routes implicit file opens to an existing visible editor group', async () => {
    const store = createDrawnEditorTabsStore()
    const { terminalTabId, terminalGroupId, editorGroupId } =
      await seedTerminalAndEditorGroups(store)

    openSourceFile(store, '/repo/next.ts')
    await main.settle()

    const openedTab = findUnifiedTabByEntity(store, '/repo/next.ts')
    const terminalGroup = store
      .getState()
      .groupsByWorktree['wt-1'].find((group) => group.id === terminalGroupId)
    const editorGroup = store
      .getState()
      .groupsByWorktree['wt-1'].find((group) => group.id === editorGroupId)
    expect(openedTab?.groupId).toBe(editorGroupId)
    expect(editorGroup?.activeTabId).toBe(openedTab?.id)
    expect(terminalGroup?.activeTabId).toBe(terminalTabId)
  })

  it('uses editor-recent groups when no inactive group is currently showing an editor', async () => {
    const store = createDrawnEditorTabsStore()
    const { editorGroupId } = await seedTerminalAndEditorGroups(store)
    store.getState().createUnifiedTab('wt-1', 'browser', {
      id: 'browser-tab',
      entityId: 'browser-tab',
      label: 'Browser',
      targetGroupId: editorGroupId
    })

    openSourceFile(store, '/repo/recent-target.ts')

    expect(openedGroupOf(store, '/repo/recent-target.ts')).toBe(editorGroupId)
  })

  it('keeps explicit target groups ahead of default editor routing', async () => {
    const store = createDrawnEditorTabsStore()
    const { terminalGroupId } = await seedTerminalAndEditorGroups(store)

    openSourceFile(store, '/repo/explicit.ts', { targetGroupId: terminalGroupId })
    await main.settle()

    expect(findUnifiedTabByEntity(store, '/repo/explicit.ts')?.groupId).toBe(terminalGroupId)
  })

  it('opens implicit files in a focused browser split group instead of stealing an editor pane (#6891)', async () => {
    const store = createDrawnEditorTabsStore()
    const { editorGroupId } = await seedTerminalAndEditorGroups(store)

    // Regression #6891: with a split like Agent | Browser, focusing the browser
    // pane and opening a file sent it to another pane. A focused browser pane
    // was treated like a focused agent terminal, so the open was stolen into an
    // existing editor pane instead of the focused group.
    const browserGroupId = store.getState().createEmptySplitGroup('wt-1', editorGroupId, 'right')
    if (!browserGroupId) {
      throw new Error('Expected split browser group')
    }
    store.getState().createUnifiedTab('wt-1', 'browser', {
      id: 'browser-tab',
      entityId: 'browser-tab',
      label: 'Browser',
      targetGroupId: browserGroupId
    })
    store.setState({
      activeGroupIdByWorktree: { 'wt-1': browserGroupId },
      activeTabType: 'browser',
      activeTabTypeByWorktree: { 'wt-1': 'browser' }
    } as Partial<AppState>)

    openSourceFile(store, '/repo/from-browser.ts')

    expect(openedGroupOf(store, '/repo/from-browser.ts')).toBe(browserGroupId)
  })
})
