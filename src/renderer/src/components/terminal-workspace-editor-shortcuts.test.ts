import { beforeEach, describe, expect, it, vi } from 'vitest'
import { handleTerminalWorkspaceEditorShortcut } from './terminal-workspace-editor-shortcuts'

const { updateSettings, storeState } = vi.hoisted(() => {
  const updateSettings = vi.fn()
  const storeState = {
    activeTabType: 'editor',
    activeFileId: 'file-1',
    openFiles: [
      {
        id: 'file-1',
        filePath: '/repo/src/index.ts',
        relativePath: 'src/index.ts',
        worktreeId: 'wt-1',
        language: 'typescript',
        isDirty: false,
        mode: 'edit' as 'edit' | 'diff' | 'conflict-review' | 'markdown-preview' | 'check-details'
      }
    ],
    editorViewMode: {} as Record<string, 'edit' | 'changes'>,
    settings: { editorCenteredLayout: false },
    updateSettings
  }
  return { updateSettings, storeState }
})

vi.mock('../store', () => ({
  useAppStore: {
    getState: () => storeState
  }
}))

vi.mock('@/lib/floating-workspace-terminal-actions', () => ({
  isEventTargetInsideFloatingWorkspacePanel: () => false
}))

function shortcutEvent(): KeyboardEvent {
  return {
    repeat: false,
    preventDefault: vi.fn(),
    target: null
  } as unknown as KeyboardEvent
}

function runCenteredLayoutShortcut() {
  const notifyTerminalCapture = vi.fn()
  const event = shortcutEvent()
  const consumed = handleTerminalWorkspaceEditorShortcut({
    event,
    floatingWorkspaceFocused: false,
    matchShortcut: (actionId) => actionId === 'editor.toggleCenteredLayout',
    notifyTerminalCapture
  })
  return { consumed, event, notifyTerminalCapture }
}

describe('handleTerminalWorkspaceEditorShortcut', () => {
  beforeEach(() => {
    updateSettings.mockClear()
    storeState.activeTabType = 'editor'
    storeState.activeFileId = 'file-1'
    storeState.openFiles[0]!.mode = 'edit'
    storeState.editorViewMode = {}
    storeState.settings.editorCenteredLayout = false
  })

  it('toggles centered layout on an edit tab (#31236)', () => {
    const { consumed, event, notifyTerminalCapture } = runCenteredLayoutShortcut()

    expect(consumed).toBe(true)
    expect(event.preventDefault).toHaveBeenCalledOnce()
    expect(notifyTerminalCapture).toHaveBeenCalledWith('editor.toggleCenteredLayout')
    expect(updateSettings).toHaveBeenCalledWith({ editorCenteredLayout: true })
  })

  it('toggles centered layout on a markdown-preview tab', () => {
    storeState.openFiles[0]!.mode = 'markdown-preview'
    const { consumed, notifyTerminalCapture } = runCenteredLayoutShortcut()

    expect(consumed).toBe(true)
    expect(notifyTerminalCapture).toHaveBeenCalledWith('editor.toggleCenteredLayout')
    expect(updateSettings).toHaveBeenCalledWith({ editorCenteredLayout: true })
  })

  it('ignores centered layout on a diff tab', () => {
    storeState.openFiles[0]!.mode = 'diff'
    const { consumed, notifyTerminalCapture } = runCenteredLayoutShortcut()

    expect(consumed).toBe(false)
    expect(notifyTerminalCapture).not.toHaveBeenCalled()
    expect(updateSettings).not.toHaveBeenCalled()
  })

  it('ignores centered layout in changes mode', () => {
    storeState.editorViewMode = { 'file-1': 'changes' }
    const { consumed, notifyTerminalCapture } = runCenteredLayoutShortcut()

    expect(consumed).toBe(false)
    expect(notifyTerminalCapture).not.toHaveBeenCalled()
    expect(updateSettings).not.toHaveBeenCalled()
  })

  it('ignores centered layout on conflict-review and check-details tabs', () => {
    storeState.openFiles[0]!.mode = 'conflict-review'
    expect(runCenteredLayoutShortcut().consumed).toBe(false)
    expect(updateSettings).not.toHaveBeenCalled()

    storeState.openFiles[0]!.mode = 'check-details'
    expect(runCenteredLayoutShortcut().consumed).toBe(false)
    expect(updateSettings).not.toHaveBeenCalled()
  })

  it('ignores centered layout when the shortcut does not match', () => {
    const consumed = handleTerminalWorkspaceEditorShortcut({
      event: shortcutEvent(),
      floatingWorkspaceFocused: false,
      matchShortcut: () => false,
      notifyTerminalCapture: vi.fn()
    })

    expect(consumed).toBe(false)
    expect(updateSettings).not.toHaveBeenCalled()
  })
})
