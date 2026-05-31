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

describe('setupContextualCopy', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
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
