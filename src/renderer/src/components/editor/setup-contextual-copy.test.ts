import type { editor } from 'monaco-editor'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { setupContextualCopy } from './setup-contextual-copy'

vi.mock('@/hooks/useShortcutLabel', () => ({
  formatShortcutLabel: () => '⌘⌥C'
}))

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
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

function createCopyHintNodeMock(): {
  className: string
  offsetHeight: number
  style: { display: string }
  textContent: string
  type: string
  tabIndex: number
  setAttribute: ReturnType<typeof vi.fn>
  addEventListener: ReturnType<typeof vi.fn>
  removeEventListener: ReturnType<typeof vi.fn>
  dispatchEvent: (event: Event) => boolean
} {
  const listeners = new Map<string, Set<(event: Event) => void>>()
  return {
    className: '',
    offsetHeight: 28,
    style: { display: '' },
    textContent: '',
    type: '',
    tabIndex: 0,
    setAttribute: vi.fn(),
    addEventListener: vi.fn((type: string, listener: (event: Event) => void) => {
      const set = listeners.get(type) ?? new Set()
      set.add(listener)
      listeners.set(type, set)
    }),
    removeEventListener: vi.fn((type: string, listener: (event: Event) => void) => {
      listeners.get(type)?.delete(listener)
    }),
    dispatchEvent(event: Event) {
      for (const listener of listeners.get(event.type) ?? []) {
        listener(event)
      }
      return true
    }
  }
}

function createPointerDownEvent(button = 0): PointerEvent {
  const event = new Event('pointerdown', { cancelable: true }) as PointerEvent
  Object.defineProperty(event, 'button', { value: button })
  return event
}

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
      createElement: () => createCopyHintNodeMock()
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

  it('polls a focused editor while a contextual copy hint is visible', () => {
    const setInterval = vi.fn(() => 1)
    vi.stubGlobal('window', {
      clearInterval: vi.fn(),
      clearTimeout: vi.fn(),
      setInterval,
      setTimeout: vi.fn(() => 2)
    })
    vi.stubGlobal('document', {
      createElement: () => createCopyHintNodeMock()
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
    const editorInstance = {
      addContentWidget: vi.fn(),
      getContainerDomNode: () => ({
        addEventListener: vi.fn(),
        removeEventListener: vi.fn()
      }),
      getLayoutInfo: () => ({ height: 500 }),
      getModel: () => ({
        getLineMaxColumn: () => 4,
        getValueInRange: () => 'one\ntwo'
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
    const copyHintNode = createCopyHintNodeMock()
    vi.stubGlobal('document', {
      createElement: () => copyHintNode
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
    expect(copyHintNode.removeEventListener).toHaveBeenCalledWith(
      'pointerdown',
      expect.any(Function)
    )
  })

  it('copies the contextual selection when the hint button is pressed', async () => {
    const writeClipboardText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('window', {
      api: { ui: { writeClipboardText } },
      clearInterval: vi.fn(),
      clearTimeout: vi.fn(),
      setInterval: vi.fn(() => 1),
      setTimeout: vi.fn(() => 2)
    })
    const copyHintNode = createCopyHintNodeMock()
    vi.stubGlobal('document', {
      createElement: () => copyHintNode
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
    const setCopyToast = vi.fn()
    const editorInstance = {
      addContentWidget: vi.fn(),
      getContainerDomNode: () => ({
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        getBoundingClientRect: () => ({ left: 10, top: 20, width: 800 })
      }),
      getLayoutInfo: () => ({ height: 500 }),
      getModel: () => ({
        getLineMaxColumn: () => 4,
        getValueInRange: () => 'one\ntwo'
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
      setCopyToast,
      propsRef: {
        current: {
          language: 'typescript',
          relativePath: 'src/example.ts'
        }
      },
      copyToastTimeoutRef: { current: null }
    })

    copyHintNode.dispatchEvent(createPointerDownEvent())

    await vi.waitFor(() => {
      expect(writeClipboardText).toHaveBeenCalledWith(
        ['File: src/example.ts', 'Lines: 1-2', '', '```ts', 'one\ntwo', '```'].join('\n')
      )
    })
    expect(setCopyToast).toHaveBeenCalledWith({ left: 18, top: 64 })
    expect(copyHintNode.style.display).toBe('none')
  })
})
