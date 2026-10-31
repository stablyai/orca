// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'
import type { editor } from 'monaco-editor'
import { syncDiffEditorOriginalWordWrap } from './diff-editor-word-wrap-options'

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
