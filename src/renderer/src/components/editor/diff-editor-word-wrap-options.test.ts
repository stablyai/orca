import { describe, expect, it } from 'vitest'
import {
  applyDiffEditorWordWrapOptions,
  buildDiffEditorWordWrapOptions
} from './diff-editor-word-wrap-options'
import type { editor } from 'monaco-editor'

describe('buildDiffEditorWordWrapOptions', () => {
  it('keeps long diff lines unwrapped by default', () => {
    expect(buildDiffEditorWordWrapOptions(undefined)).toEqual({
      wordWrap: 'off',
      diffWordWrap: 'off',
      useInlineViewWhenSpaceIsLimited: false
    })
    expect(buildDiffEditorWordWrapOptions(false)).toEqual({
      wordWrap: 'off',
      diffWordWrap: 'off',
      useInlineViewWhenSpaceIsLimited: false
    })
  })

  it('enables Monaco diff word wrapping when the diff preference is on', () => {
    expect(buildDiffEditorWordWrapOptions(true)).toEqual({
      wordWrap: 'on',
      diffWordWrap: 'on',
      useInlineViewWhenSpaceIsLimited: false
    })
  })
})

function createMockCodeEditor(
  initialWordWrap: 'on' | 'off' = 'off',
  initialOverride: 'on' | 'off' | 'inherit' = 'inherit'
): {
  editor: editor.ICodeEditor
  emitDidChangeConfiguration: () => void
  getWordWrap: () => 'on' | 'off' | undefined
  getWordWrapOverride2: () => 'on' | 'off' | 'inherit' | undefined
} {
  let wordWrap: 'on' | 'off' = initialWordWrap
  let wordWrapOverride2: 'on' | 'off' | 'inherit' = initialOverride
  const listeners = new Set<() => void>()

  const mockEditor = {
    getRawOptions: () => ({ wordWrap, wordWrapOverride2 }),
    updateOptions: ({
      wordWrap: nextWordWrap,
      wordWrapOverride2: nextOverride
    }: {
      wordWrap?: 'on' | 'off'
      wordWrapOverride2?: 'on' | 'off' | 'inherit'
    }) => {
      if (nextWordWrap) {
        wordWrap = nextWordWrap
      }
      if (nextOverride) {
        wordWrapOverride2 = nextOverride
      }
    },
    onDidChangeConfiguration: (listener: () => void) => {
      listeners.add(listener)
      return {
        dispose: () => {
          listeners.delete(listener)
        }
      }
    }
  } as unknown as editor.ICodeEditor

  return {
    editor: mockEditor,
    emitDidChangeConfiguration: () => {
      listeners.forEach((listener) => listener())
    },
    getWordWrap: () => wordWrap,
    getWordWrapOverride2: () => wordWrapOverride2
  }
}

describe('applyDiffEditorWordWrapOptions', () => {
  it('forces wrap on both panes and clears a stuck original override', () => {
    const original = createMockCodeEditor('off', 'off')
    const modified = createMockCodeEditor('off', 'inherit')
    const diffEditor = {
      getOriginalEditor: () => original.editor,
      getModifiedEditor: () => modified.editor
    } as unknown as editor.IStandaloneDiffEditor

    const disposable = applyDiffEditorWordWrapOptions(diffEditor, true)

    expect(original.getWordWrap()).toBe('on')
    expect(original.getWordWrapOverride2()).toBe('inherit')
    expect(modified.getWordWrap()).toBe('on')
    expect(modified.getWordWrapOverride2()).toBe('inherit')

    original.editor.updateOptions({ wordWrap: 'off', wordWrapOverride2: 'off' })
    original.emitDidChangeConfiguration()
    expect(original.getWordWrap()).toBe('on')
    expect(original.getWordWrapOverride2()).toBe('inherit')

    disposable.dispose()
    original.editor.updateOptions({ wordWrap: 'off', wordWrapOverride2: 'off' })
    original.emitDidChangeConfiguration()
    expect(original.getWordWrap()).toBe('off')
    expect(original.getWordWrapOverride2()).toBe('off')
  })
})
