// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { runOrcaContextMenuPaste, type OrcaContextMenuPasteDeps } from './monaco-context-menu-paste'

const READ_ONLY_OPTION = 104
const EMPTY_SELECTION_OPTION = 45

type FakeEditorState = {
  hasTextFocus?: boolean
  hasModel?: boolean
  readOnly?: boolean
  emptySelectionClipboard?: boolean
}

function makeEditor(state: FakeEditorState = {}) {
  const {
    hasTextFocus = true,
    hasModel = true,
    readOnly = false,
    emptySelectionClipboard = false
  } = state
  let focused = hasTextFocus
  const trigger = vi.fn()
  let model: object | null = hasModel ? {} : null
  // Chunked paste rechecks model/container identity, so fixture instances must remain stable.
  const container = document.createElement('div')
  document.body.appendChild(container)
  const editor = {
    getModel: () => model,
    hasTextFocus: () => focused,
    getOption: (id: number) => {
      if (id === READ_ONLY_OPTION) {
        return readOnly
      }
      if (id === EMPTY_SELECTION_OPTION) {
        return emptySelectionClipboard
      }
      return undefined
    },
    trigger,
    getContainerDomNode: () => container,
    getSelection: () => ({
      startLineNumber: 1,
      startColumn: 1,
      endLineNumber: 1,
      endColumn: 1
    }),
    setSelection: vi.fn(),
    executeEdits: vi.fn(() => true),
    pushUndoStop: vi.fn(() => true)
  }
  return {
    editor,
    trigger,
    replaceModel: () => {
      model = {}
    },
    setFocused: (next: boolean) => {
      focused = next
    }
  }
}

function makeDeps(
  overrides: Partial<OrcaContextMenuPasteDeps> & { editor?: ReturnType<typeof makeEditor> }
): OrcaContextMenuPasteDeps {
  const editorHandle = overrides.editor ?? makeEditor()
  return {
    getFocusedEditor: () => editorHandle.editor as never,
    readClipboardText: vi.fn(async () => 'pasted text'),
    getClipboardMetadata: () => null,
    emptySelectionClipboardOptionId: EMPTY_SELECTION_OPTION as never,
    readOnlyOptionId: READ_ONLY_OPTION as never,
    ...overrides
  }
}

afterEach(() => {
  document.body.replaceChildren()
  vi.restoreAllMocks()
})

describe('runOrcaContextMenuPaste', () => {
  it('does not dispatch a native paste if focus is lost during the async read', async () => {
    const handle = makeEditor()
    const deps = makeDeps({
      editor: handle,
      readClipboardText: vi.fn(async () => {
        handle.setFocused(false)
        return 'late text'
      })
    })

    await expect(runOrcaContextMenuPaste(deps)).resolves.toEqual({
      status: 'noop',
      reason: 'target-lost'
    })
    expect(handle.trigger).not.toHaveBeenCalled()
  })
})
