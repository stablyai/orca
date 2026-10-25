import type { editor } from 'monaco-editor'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { setupContextualCopy } from './setup-contextual-copy'

vi.mock('@/hooks/useShortcutLabel', () => ({
  formatShortcutLabel: () => 'Copy Context'
}))

vi.mock('@/lib/monaco-setup', () => ({
  monaco: {
    editor: {
      ContentWidgetPositionPreference: {
        ABOVE: 1,
        BELOW: 2
      }
    }
  }
}))

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => ({ keybindings: {} })
  }
}))

vi.mock('@/lib/primary-selection', () => ({
  PRIMARY_SELECTION_MAX_LENGTH: 10_000,
  isPrimarySelectionEnabled: () => false,
  setPrimarySelectionText: () => {}
}))

vi.mock('./editor-shortcuts', () => ({ editorShortcutMatches: () => true }))

describe('setupContextualCopy', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('does not poll a focused editor when no contextual copy hint is visible', () => {
    const setInterval = vi.fn(() => 1)
    vi.stubGlobal('window', {
      clearInterval: vi.fn(),
      clearTimeout: vi.fn(),
      setInterval,
      setTimeout: vi.fn(() => 2)
    })
    vi.stubGlobal('document', {
      createElement: () => ({
        className: '',
        offsetHeight: 28,
        style: { display: '' },
        textContent: ''
      })
    })

    const editorInstance = {
      addContentWidget: vi.fn(),
      getContainerDomNode: () => ({
        addEventListener: vi.fn(),
        removeEventListener: vi.fn()
      }),
      getModel: () => null,
      getSelection: () => null,
      hasTextFocus: () => true,
      layoutContentWidget: vi.fn(),
      onDidBlurEditorText: () => ({ dispose: vi.fn() }),
      onDidChangeCursorSelection: () => ({ dispose: vi.fn() }),
      onDidDispose: () => ({ dispose: vi.fn() }),
      onDidFocusEditorText: () => ({ dispose: vi.fn() }),
      onDidScrollChange: () => ({ dispose: vi.fn() }),
      removeContentWidget: vi.fn()
    } as unknown as editor.IStandaloneCodeEditor

    setupContextualCopy({
      editorInstance,
      filePath: 'src/example.ts',
      setCopyToast: vi.fn(),
      propsRef: {
        current: {
          language: 'typescript',
          relativePath: 'src/example.ts'
        }
      },
      copyToastTimeoutRef: { current: null }
    })

    expect(setInterval).not.toHaveBeenCalled()
  })

  it('refreshes a visible hint without reading selection text and extracts it only on copy', async () => {
    let refreshHint = (): void => {}
    let keydown = (_event: KeyboardEvent): void => {}
    const setInterval = vi.fn((callback: () => void) => {
      refreshHint = callback
      return 1
    })
    const writeClipboardText = vi.fn(async (_text: string) => {})
    vi.stubGlobal('window', {
      api: { ui: { writeClipboardText } },
      clearInterval: vi.fn(),
      clearTimeout: vi.fn(),
      setInterval,
      setTimeout: vi.fn(() => 2)
    })
    vi.stubGlobal('document', {
      createElement: () => ({
        className: '',
        offsetHeight: 28,
        style: { display: '' },
        textContent: ''
      })
    })

    const selection = {
      startLineNumber: 1,
      startColumn: 1,
      endLineNumber: 2,
      endColumn: 4,
      isEmpty: () => false,
      getStartPosition: () => ({ lineNumber: 1, column: 1 }),
      getEndPosition: () => ({ lineNumber: 2, column: 4 })
    }
    const selectedText = `${'x'.repeat(4 * 1024 * 1024)}\ntwo`
    const getValueInRange = vi.fn(() => selectedText)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The editor stub implements every method setupContextualCopy invokes in this scenario.
    const editorInstance = {
      addContentWidget: vi.fn(),
      getContainerDomNode: () => ({
        addEventListener: (type: string, callback: (event: KeyboardEvent) => void) => {
          if (type === 'keydown') {
            keydown = callback
          }
        },
        removeEventListener: vi.fn(),
        getBoundingClientRect: () => ({ left: 0, top: 0, width: 500 })
      }),
      getLayoutInfo: () => ({ height: 500 }),
      getModel: () => ({
        getLineMaxColumn: () => 4,
        getValueInRange
      }),
      getScrolledVisiblePosition: () => ({ top: 20, left: 8, height: 16 }),
      getSelection: () => selection,
      hasTextFocus: () => true,
      layoutContentWidget: vi.fn(),
      onDidBlurEditorText: () => ({ dispose: vi.fn() }),
      onDidChangeCursorSelection: () => ({ dispose: vi.fn() }),
      onDidDispose: () => ({ dispose: vi.fn() }),
      onDidFocusEditorText: () => ({ dispose: vi.fn() }),
      onDidScrollChange: () => ({ dispose: vi.fn() }),
      removeContentWidget: vi.fn()
    } as unknown as editor.IStandaloneCodeEditor

    setupContextualCopy({
      editorInstance,
      filePath: 'src/example.ts',
      setCopyToast: vi.fn(),
      propsRef: {
        current: {
          language: 'typescript',
          relativePath: 'src/example.ts'
        }
      },
      copyToastTimeoutRef: { current: null }
    })

    expect(setInterval).toHaveBeenCalledTimes(1)
    for (let tick = 0; tick < 20; tick += 1) {
      refreshHint()
    }
    expect(getValueInRange).not.toHaveBeenCalled()

    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Shortcut matching is mocked; the handler reads only these event methods.
    keydown({ preventDefault: vi.fn(), stopPropagation: vi.fn() } as unknown as KeyboardEvent)
    await Promise.resolve()
    expect(getValueInRange).toHaveBeenCalledTimes(1)
    expect(writeClipboardText).toHaveBeenCalledWith(
      `File: src/example.ts\nLines: 1-2\n\n\`\`\`ts\n${selectedText}\n\`\`\``
    )
    refreshHint()
    expect(getValueInRange).toHaveBeenCalledTimes(1)
  })

  it('clears editor-scoped contextual copy cleanup on dispose', () => {
    const clearTimeout = vi.fn()
    const clearInterval = vi.fn()
    vi.stubGlobal('window', {
      clearInterval,
      clearTimeout,
      setInterval: vi.fn(() => 1),
      setTimeout: vi.fn(() => 2)
    })
    vi.stubGlobal('document', {
      createElement: () => ({
        className: '',
        offsetHeight: 28,
        style: { display: '' },
        textContent: ''
      })
    })

    const editorDomNode = {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn()
    }
    const selectionDispose = vi.fn()
    const scrollDispose = vi.fn()
    const focusDispose = vi.fn()
    const blurDispose = vi.fn()
    let disposeEditor = (): void => {}
    const editorInstance = {
      addContentWidget: vi.fn(),
      getContainerDomNode: () => editorDomNode,
      getModel: () => null,
      getSelection: () => null,
      hasTextFocus: () => false,
      layoutContentWidget: vi.fn(),
      onDidBlurEditorText: () => ({ dispose: blurDispose }),
      onDidChangeCursorSelection: () => ({ dispose: selectionDispose }),
      onDidDispose: (listener: () => void) => {
        disposeEditor = listener
        return { dispose: vi.fn() }
      },
      onDidFocusEditorText: () => ({ dispose: focusDispose }),
      onDidScrollChange: () => ({ dispose: scrollDispose }),
      removeContentWidget: vi.fn()
    } as unknown as editor.IStandaloneCodeEditor
    const copyToastTimeoutRef = { current: 42 }
    const setCopyToast = vi.fn()

    setupContextualCopy({
      editorInstance,
      filePath: 'src/example.ts',
      setCopyToast,
      propsRef: {
        current: {
          language: 'typescript',
          relativePath: 'src/example.ts'
        }
      },
      copyToastTimeoutRef
    })

    disposeEditor()

    expect(selectionDispose).toHaveBeenCalledTimes(1)
    expect(scrollDispose).toHaveBeenCalledTimes(1)
    expect(focusDispose).toHaveBeenCalledTimes(1)
    expect(blurDispose).toHaveBeenCalledTimes(1)
    expect(clearTimeout).toHaveBeenCalledWith(42)
    expect(copyToastTimeoutRef.current).toBeNull()
    expect(setCopyToast).toHaveBeenCalledWith(null)
    expect(editorDomNode.removeEventListener).toHaveBeenCalledTimes(3)
  })
})
