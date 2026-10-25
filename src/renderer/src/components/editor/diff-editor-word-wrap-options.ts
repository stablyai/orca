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
    // Why: `wordWrap` alone reaches the modified pane; the original pane follows `diffWordWrap`.
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
  // Why: createDiffEditor's container never receives the class. Monaco appends
  // `div.monaco-diff-editor` and toggles `side-by-side` on that child.
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
    // Why: inline layout hides the original editor and sets wordWrapOverride2 to off.
    // Side-by-side only writes wordWrapOverride1, so the off value sticks after a widen (#24199).
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

  // Why: Monaco updates the inner editor and the side-by-side class in the same turn.
  // Applying on the next microtask sees the class after that turn settles.
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
