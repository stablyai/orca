// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'
import type { editor } from 'monaco-editor'
import {
  buildDiffEditorWordWrapOptions,
  syncDiffEditorOriginalWordWrap
} from './diff-editor-word-wrap-options'

describe('buildDiffEditorWordWrapOptions', () => {
  it('keeps long diff lines unwrapped by default', () => {
    expect(buildDiffEditorWordWrapOptions(undefined)).toEqual({
      wordWrap: 'off',
      diffWordWrap: 'off'
    })
    expect(buildDiffEditorWordWrapOptions(false)).toEqual({
      wordWrap: 'off',
      diffWordWrap: 'off'
    })
  })

  it('enables Monaco diff word wrapping on both panes when the diff preference is on', () => {
    expect(buildDiffEditorWordWrapOptions(true)).toEqual({
      wordWrap: 'on',
      diffWordWrap: 'on'
    })
  })
})

describe('syncDiffEditorOriginalWordWrap', () => {
  function fakeEditor() {
    const listeners = new Set<() => void>()
    let options: editor.IEditorOptions = {}
    const editorStub = {
      updateOptions: vi.fn((next: editor.IEditorOptions) => {
        options = { ...options, ...next }
      }),
      getRawOptions: () => options,
      onDidChangeConfiguration: (listener: () => void) => {
        listeners.add(listener)
        return {
          dispose: () => {
            listeners.delete(listener)
          }
        }
      },
      emitDidChangeConfiguration: () => {
        listeners.forEach((listener) => listener())
      }
    }
    return editorStub
  }

  function monacoDiffHost(sideBySide: boolean): HTMLElement {
    const host = document.createElement('div')
    const widget = document.createElement('div')
    widget.classList.add('monaco-diff-editor')
    widget.classList.toggle('side-by-side', sideBySide)
    host.append(widget)
    return host
  }

  function fakeDiffEditor(root = monacoDiffHost(true)): {
    diffEditor: Parameters<typeof syncDiffEditorOriginalWordWrap>[0]
    original: ReturnType<typeof fakeEditor>
    modified: ReturnType<typeof fakeEditor>
  } {
    const original = fakeEditor()
    const modified = fakeEditor()
    return {
      original,
      modified,
      diffEditor: {
        getOriginalEditor: () => original,
        getModifiedEditor: () => modified,
        getContainerDomNode: () => root
      }
    }
  }

  it('clears the original pane override that stays off after Monaco leaves inline layout', () => {
    const { diffEditor, original, modified } = fakeDiffEditor()

    syncDiffEditorOriginalWordWrap(diffEditor, true)

    expect(original.updateOptions).toHaveBeenCalledWith({
      wordWrap: 'on',
      wordWrapOverride2: 'inherit'
    })
    expect(modified.updateOptions).toHaveBeenCalledWith({ wordWrap: 'on' })
  })

  it('keeps both panes unwrapped when the preference is off', () => {
    const { diffEditor, original, modified } = fakeDiffEditor()

    syncDiffEditorOriginalWordWrap(diffEditor, false)

    expect(original.updateOptions).toHaveBeenCalledWith({
      wordWrap: 'off',
      wordWrapOverride2: 'off'
    })
    expect(modified.updateOptions).toHaveBeenCalledWith({ wordWrap: 'off' })
  })

  it('reapplies the original pane wrap after Monaco clears it, and stops after dispose', async () => {
    const root = monacoDiffHost(true)
    expect(root.classList.contains('side-by-side')).toBe(false)
    const { diffEditor, original } = fakeDiffEditor(root)
    const disposable = syncDiffEditorOriginalWordWrap(diffEditor, true)
    original.updateOptions.mockClear()

    original.updateOptions({ wordWrapOverride2: 'off' })
    original.emitDidChangeConfiguration()
    await Promise.resolve()

    expect(original.getRawOptions().wordWrapOverride2).toBe('inherit')

    original.updateOptions.mockClear()
    disposable.dispose()
    original.updateOptions({ wordWrapOverride2: 'off' })
    original.emitDidChangeConfiguration()
    await Promise.resolve()

    expect(original.getRawOptions().wordWrapOverride2).toBe('off')
    expect(original.updateOptions).toHaveBeenCalledTimes(1)
  })

  it('leaves the hidden original pane unwrapped while Monaco is inline', async () => {
    const root = monacoDiffHost(false)
    const { diffEditor, original } = fakeDiffEditor(root)

    syncDiffEditorOriginalWordWrap(diffEditor, true)

    expect(original.getRawOptions().wordWrapOverride2).toBe('off')

    original.updateOptions({ wordWrapOverride2: 'inherit' })
    original.emitDidChangeConfiguration()
    await Promise.resolve()

    expect(original.getRawOptions().wordWrapOverride2).toBe('off')
  })

  it('observes the settled layout after an inline-to-side-by-side transition', async () => {
    const host = monacoDiffHost(false)
    const { diffEditor, original, modified } = fakeDiffEditor(host)
    const disposable = syncDiffEditorOriginalWordWrap(diffEditor, true)

    original.emitDidChangeConfiguration()
    modified.emitDidChangeConfiguration()
    host.querySelector('.monaco-diff-editor')?.classList.add('side-by-side')
    await Promise.resolve()

    expect(original.getRawOptions().wordWrapOverride2).toBe('inherit')
    disposable.dispose()
  })

  it('cancels a queued update when the editor is disposed', async () => {
    const { diffEditor, original } = fakeDiffEditor()
    const disposable = syncDiffEditorOriginalWordWrap(diffEditor, true)
    original.updateOptions({ wordWrapOverride2: 'off' })
    original.emitDidChangeConfiguration()
    disposable.dispose()
    await Promise.resolve()

    expect(original.getRawOptions().wordWrapOverride2).toBe('off')
  })
})
