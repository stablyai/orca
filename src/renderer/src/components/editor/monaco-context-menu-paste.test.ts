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
  const model = hasModel ? ({} as object) : null
  // Why: the chunked inserter snapshots the container/model and re-checks identity
  // each chunk, so these must be stable across calls.
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
    // Surface used only by the large-paste chunked inserter.
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
  it('falls through (returns false) when no editor is focused', () => {
    const deps = makeDeps({ getFocusedEditor: () => null })
    expect(runOrcaContextMenuPaste(deps)).toBe(false)
  })

  it('falls through when the focused editor has no model', () => {
    const handle = makeEditor({ hasModel: false })
    const deps = makeDeps({ editor: handle })
    expect(runOrcaContextMenuPaste(deps)).toBe(false)
  })

  it('falls through when the editor lacks text focus', () => {
    const handle = makeEditor({ hasTextFocus: false })
    const deps = makeDeps({ editor: handle })
    expect(runOrcaContextMenuPaste(deps)).toBe(false)
  })

  it('falls through for read-only editors without reading the clipboard', () => {
    const handle = makeEditor({ readOnly: true })
    const readClipboardText = vi.fn(async () => 'x')
    const deps = makeDeps({ editor: handle, readClipboardText })
    expect(runOrcaContextMenuPaste(deps)).toBe(false)
    expect(readClipboardText).not.toHaveBeenCalled()
  })

  it('reads via IPC and dispatches a native paste for writable focused editors', async () => {
    const handle = makeEditor()
    const readClipboardText = vi.fn(async () => 'hello world')
    const deps = makeDeps({ editor: handle, readClipboardText })

    const outcome = runOrcaContextMenuPaste(deps)
    expect(outcome).not.toBe(false)
    await expect(outcome).resolves.toEqual({ status: 'pasted', mode: 'native' })
    expect(readClipboardText).toHaveBeenCalledWith({ maxBytes: 16 * 1024 * 1024 })
    expect(handle.trigger).toHaveBeenCalledWith('keyboard', 'paste', {
      text: 'hello world',
      pasteOnNewLine: false,
      multicursorText: null,
      mode: null
    })
  })

  it('applies in-app copy metadata (empty-selection + multicursor) when enabled', async () => {
    const handle = makeEditor({ emptySelectionClipboard: true })
    const deps = makeDeps({
      editor: handle,
      readClipboardText: vi.fn(async () => 'line text'),
      getClipboardMetadata: () => ({
        isFromEmptySelection: true,
        multicursorText: ['a', 'b'],
        mode: 'typescript'
      })
    })

    await runOrcaContextMenuPaste(deps)
    expect(handle.trigger).toHaveBeenCalledWith('keyboard', 'paste', {
      text: 'line text',
      pasteOnNewLine: true,
      multicursorText: ['a', 'b'],
      mode: 'typescript'
    })
  })

  it('ignores empty-selection metadata when the option is disabled', async () => {
    const handle = makeEditor({ emptySelectionClipboard: false })
    const deps = makeDeps({
      editor: handle,
      readClipboardText: vi.fn(async () => 'line text'),
      getClipboardMetadata: () => ({ isFromEmptySelection: true })
    })

    await runOrcaContextMenuPaste(deps)
    expect(handle.trigger).toHaveBeenCalledWith(
      'keyboard',
      'paste',
      expect.objectContaining({ pasteOnNewLine: false })
    )
  })

  it('does nothing on an empty clipboard', async () => {
    const handle = makeEditor()
    const deps = makeDeps({ editor: handle, readClipboardText: vi.fn(async () => '') })
    await expect(runOrcaContextMenuPaste(deps)).resolves.toEqual({
      status: 'noop',
      reason: 'empty'
    })
    expect(handle.trigger).not.toHaveBeenCalled()
  })

  it('surfaces a too-large toast and does not dispatch when the IPC read rejects', async () => {
    const handle = makeEditor()
    const onReadError = vi.fn()
    const deps = makeDeps({
      editor: handle,
      readClipboardText: vi.fn(async () => {
        throw new Error('Clipboard text is too large for this paste target.')
      }),
      onReadError
    })

    await expect(runOrcaContextMenuPaste(deps)).resolves.toEqual({
      status: 'noop',
      reason: 'read-failed'
    })
    expect(handle.trigger).not.toHaveBeenCalled()
    expect(onReadError).toHaveBeenCalled()
  })

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

  it('routes oversized pastes through the chunked inserter instead of a native trigger', async () => {
    const handle = makeEditor()
    // 128 KiB exceeds the 64 KiB direct-paste threshold but is under the 16 MiB cap.
    const bigText = 'x'.repeat(128 * 1024)
    const deps = makeDeps({ editor: handle, readClipboardText: vi.fn(async () => bigText) })

    const outcome = await runOrcaContextMenuPaste(deps)
    expect(outcome).toEqual({ status: 'pasted', mode: 'chunked' })
    expect(handle.trigger).not.toHaveBeenCalled()
    expect(handle.editor.executeEdits).toHaveBeenCalled()
  })
})
