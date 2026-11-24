import type { editor } from 'monaco-editor'

export function diffEditorWordWrapMode(diffWordWrap: boolean | undefined): 'on' | 'off' {
  return diffWordWrap === true ? 'on' : 'off'
}

export function buildDiffEditorWordWrapOptions(
  diffWordWrap: boolean | undefined
): Pick<editor.IStandaloneDiffEditorConstructionOptions, 'wordWrap' | 'diffWordWrap'> {
  const wrap = diffEditorWordWrapMode(diffWordWrap)
  return {
    wordWrap: wrap,
    // wordWrap affects the modified pane; the original also requires diffWordWrap.
    diffWordWrap: wrap
  }
}

type Disposable = { dispose: () => void }

type WordWrapEditor = Pick<editor.ICodeEditor, 'getRawOptions' | 'updateOptions'> & {
  onDidChangeConfiguration: (listener: () => void) => Disposable
}

type WordWrapDiffEditor = Pick<editor.IStandaloneDiffEditor, 'getContainerDomNode'> & {
  getOriginalEditor: () => WordWrapEditor
  getModifiedEditor: () => WordWrapEditor
}

function diffEditorIsSideBySide(diffEditor: WordWrapDiffEditor): boolean {
  const host = diffEditor.getContainerDomNode?.()
  if (!host) {
    return true
  }
  // Monaco places its side-by-side class on the nested diff widget, not necessarily the host container.
  const widget = host.classList.contains('monaco-diff-editor')
    ? host
    : host.querySelector?.('.monaco-diff-editor')
  if (!widget) {
    return true
  }
  return widget.classList.contains('side-by-side')
}

export function syncDiffEditorOriginalWordWrap(
  diffEditor: WordWrapDiffEditor,
  diffWordWrap: boolean | undefined
): Disposable {
  const originalEditor = diffEditor.getOriginalEditor()
  const modifiedEditor = diffEditor.getModifiedEditor()
  let disposed = false
  let scheduled = false

  const apply = (): void => {
    if (disposed) {
      return
    }
    const wrap = diffEditorWordWrapMode(diffWordWrap)
    // Inline mode pins wordWrapOverride2 off; side-by-side updates only override1, so widening must reset the stale override2.
    const showOriginal = diffEditorIsSideBySide(diffEditor)
    const override = wrap === 'on' && showOriginal ? 'inherit' : 'off'
    const originalOptions = originalEditor.getRawOptions()
    if (originalOptions.wordWrap !== wrap || originalOptions.wordWrapOverride2 !== override) {
      originalEditor.updateOptions({ wordWrap: wrap, wordWrapOverride2: override })
    }
    if (modifiedEditor.getRawOptions().wordWrap !== wrap) {
      modifiedEditor.updateOptions({ wordWrap: wrap })
    }
  }

  // Defer to a microtask so Monaco’s inner options and layout class settle before applying the override.
  const schedule = (): void => {
    if (disposed || scheduled) {
      return
    }
    scheduled = true
    queueMicrotask(() => {
      scheduled = false
      apply()
    })
  }

  apply()
  const originalSub = originalEditor.onDidChangeConfiguration(schedule)
  const modifiedSub = modifiedEditor.onDidChangeConfiguration(schedule)

  return {
    dispose: () => {
      disposed = true
      originalSub.dispose()
      modifiedSub.dispose()
    }
  }
}
