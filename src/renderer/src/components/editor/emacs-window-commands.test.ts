// @vitest-environment happy-dom

import type { StoreApi } from 'zustand/vanilla'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppState } from '@/store/types'
import type { OpenFile } from '@/store/slices/editor/types/open-file'
import { createEditorTabsStore } from '@/store/slices/editor-slice-test-harness'

const { dispatchWorkspaceTabCommand, focusTerminalTabSurface, appStore } = vi.hoisted(() => {
  const appStore: { current: StoreApi<AppState> | null } = { current: null }
  return {
    dispatchWorkspaceTabCommand: vi.fn(() => true),
    focusTerminalTabSurface: vi.fn(),
    appStore
  }
})
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))
vi.mock('@/lib/workspace-tab-commands', () => ({ dispatchWorkspaceTabCommand }))
vi.mock('@/lib/focus-terminal-tab-surface', () => ({ focusTerminalTabSurface }))
vi.mock('@/store', () => ({
  useAppStore: { getState: () => appStore.current?.getState() }
}))
// Why: the split focus handoff retries over frames; tests run them explicitly.
const frames: FrameRequestCallback[] = []
vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => frames.push(callback))

import {
  createEmacsEditorHooks,
  deleteEmacsWindow,
  focusOtherEmacsWindow,
  splitEmacsWindow,
  type EmacsWindowView
} from './emacs-window-commands'

function fileInput(filePath: string): Omit<OpenFile, 'id' | 'isDirty'> {
  return {
    filePath,
    relativePath: filePath.replace('/repo/', ''),
    worktreeId: 'wt-1',
    language: 'typescript',
    mode: 'edit'
  }
}

function tabs(store: StoreApi<AppState>) {
  return store.getState().unifiedTabsByWorktree['wt-1'] ?? []
}

function groups(store: StoreApi<AppState>) {
  return store.getState().groupsByWorktree['wt-1'] ?? []
}

function activeGroupId(store: StoreApi<AppState>): string | undefined {
  return store.getState().activeGroupIdByWorktree['wt-1']
}

/** One file open in the root group; returns the view the Emacs editor would report. */
function openFile(store: StoreApi<AppState>, filePath = '/repo/a.ts'): EmacsWindowView {
  const fileId = store.getState().openFile(fileInput(filePath), {})
  const tab = tabs(store).find((entry) => entry.entityId === fileId)
  if (!tab) {
    throw new Error('Expected an editor tab')
  }
  return { worktreeId: 'wt-1', fileId, viewStateId: tab.id }
}

/** Stands in for a mounted Monaco view: its focusable input, found by the view attribute. */
function mountEditorView(viewStateId: string): HTMLElement {
  const container = document.createElement('div')
  container.setAttribute('data-orca-editor-view', viewStateId)
  container.innerHTML =
    '<div class="monaco-editor"><div class="native-edit-context" tabindex="0"></div></div>'
  document.body.append(container)
  return container.querySelector<HTMLElement>('.native-edit-context')!
}

function runFrames(): void {
  while (frames.length > 0) {
    frames.shift()?.(0)
  }
}

let store: StoreApi<AppState>

beforeEach(() => {
  store = createEditorTabsStore()
  appStore.current = store
  dispatchWorkspaceTabCommand.mockClear()
  focusTerminalTabSurface.mockClear()
  frames.length = 0
  document.body.innerHTML = ''
})

describe('splitEmacsWindow', () => {
  it('shows the same file in a new group beside this one and moves there', () => {
    const view = openFile(store)
    const sourceGroupId = groups(store)[0]!.id

    expect(splitEmacsWindow(store, view, 'right')).toBe(true)

    expect(groups(store)).toHaveLength(2)
    const newGroup = groups(store).find((group) => group.id !== sourceGroupId)!
    expect(activeGroupId(store)).toBe(newGroup.id)
    const views = tabs(store).filter((tab) => tab.entityId === view.fileId)
    expect(views.map((tab) => tab.groupId).sort()).toEqual([newGroup.id, sourceGroupId].sort())
    expect(store.getState().openFiles).toHaveLength(1)
    expect(store.getState().layoutByWorktree['wt-1']).toMatchObject({
      type: 'split',
      direction: 'horizontal'
    })
  })

  it('does nothing for a view it cannot find', () => {
    const view = openFile(store)
    expect(splitEmacsWindow(store, { ...view, viewStateId: 'gone' }, 'down')).toBe(false)
    expect(groups(store)).toHaveLength(1)
  })
})

describe('focusOtherEmacsWindow', () => {
  it('cycles through the layout leaves and lands on each group’s visible tab', () => {
    const view = openFile(store)
    splitEmacsWindow(store, view, 'down')
    const [first, second] = groups(store).map((group) => group.id)
    const secondView = tabs(store).find(
      (tab) => tab.entityId === view.fileId && tab.groupId === second
    )!
    expect(activeGroupId(store)).toBe(second)

    expect(focusOtherEmacsWindow(store, { ...view, viewStateId: secondView.id })).toBe(true)
    expect(activeGroupId(store)).toBe(first)
    expect(store.getState().activeFileId).toBe(view.fileId)

    expect(focusOtherEmacsWindow(store, view)).toBe(true)
    expect(activeGroupId(store)).toBe(second)
  })

  it('focuses a terminal when the other window shows one', () => {
    const view = openFile(store)
    const sourceGroupId = groups(store)[0]!.id
    const terminalGroupId = store.getState().createEmptySplitGroup('wt-1', sourceGroupId, 'right')!
    store.getState().createUnifiedTab('wt-1', 'terminal', {
      id: 'term-1',
      entityId: 'term-entity',
      label: 'term',
      targetGroupId: terminalGroupId
    })
    store.getState().focusGroup('wt-1', sourceGroupId)
    // The harness has no terminal slice; the editor+tabs slices cover everything else.
    const setActiveTab = vi.fn()
    store.setState({ setActiveTab })

    expect(focusOtherEmacsWindow(store, view)).toBe(true)
    expect(activeGroupId(store)).toBe(terminalGroupId)
    expect(setActiveTab).toHaveBeenCalledWith('term-entity')
    expect(focusTerminalTabSurface).toHaveBeenCalledWith('term-entity')
  })

  it('is a no-op with a single window', () => {
    const view = openFile(store)
    expect(focusOtherEmacsWindow(store, view)).toBe(false)
  })
})

describe('deleteEmacsWindow', () => {
  it('closes only this view, and never the sole window', () => {
    const view = openFile(store)
    expect(deleteEmacsWindow(store, view)).toBe(false)
    expect(dispatchWorkspaceTabCommand).not.toHaveBeenCalled()

    splitEmacsWindow(store, view, 'right')
    const other = tabs(store).find(
      (tab) => tab.entityId === view.fileId && tab.id !== view.viewStateId
    )!
    expect(deleteEmacsWindow(store, { ...view, viewStateId: other.id })).toBe(true)
    expect(dispatchWorkspaceTabCommand).toHaveBeenCalledWith({
      type: 'close',
      target: { kind: 'tab', worktreeId: 'wt-1', tabId: other.id }
    })
  })
})

describe('createEmacsEditorHooks', () => {
  it('reads the view per key and skips editors without one', () => {
    const view = openFile(store)
    let current: EmacsWindowView | null = null
    const onSave = vi.fn()
    const hooks = createEmacsEditorHooks(() => current, onSave)

    hooks.onSplitWindow('right')
    expect(groups(store)).toHaveLength(1)

    current = view
    hooks.onSplitWindow('right')
    expect(groups(store)).toHaveLength(2)
    hooks.onSave()
    expect(onSave).toHaveBeenCalledTimes(1)
  })

  it('lets the next window command take focus from a split that is still settling', () => {
    const view = openFile(store)
    const hooks = createEmacsEditorHooks(() => view, vi.fn())
    const firstInput = mountEditorView(view.viewStateId)
    hooks.onSplitWindow('right')
    const created = tabs(store).find(
      (tab) => tab.entityId === view.fileId && tab.id !== view.viewStateId
    )!
    const secondInput = mountEditorView(created.id)
    frames.shift()?.(0)
    expect(document.activeElement).toBe(secondInput)

    // `C-x o` from the new view before the hold has run out.
    createEmacsEditorHooks(() => ({ ...view, viewStateId: created.id }), vi.fn()).onOtherWindow()
    runFrames()
    expect(document.activeElement).toBe(firstInput)
  })

  it('stops holding focus on a new split once the user clicks elsewhere', () => {
    const view = openFile(store)
    mountEditorView(view.viewStateId)
    createEmacsEditorHooks(() => view, vi.fn()).onSplitWindow('right')
    const created = tabs(store).find(
      (tab) => tab.entityId === view.fileId && tab.id !== view.viewStateId
    )!
    mountEditorView(created.id)
    frames.shift()?.(0)

    const elsewhere = document.createElement('button')
    document.body.append(elsewhere)
    elsewhere.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    elsewhere.focus()
    runFrames()
    expect(document.activeElement).toBe(elsewhere)
  })
})
