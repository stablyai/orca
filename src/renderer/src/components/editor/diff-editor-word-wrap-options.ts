import type { editor } from 'monaco-editor'

type DiffEditorWordWrap = 'on' | 'off'

type Disposable = {
  dispose: () => void
}

function resolveDiffEditorWordWrap(diffWordWrap: boolean | undefined): DiffEditorWordWrap {
  return diffWordWrap === true ? 'on' : 'off'
}

export function buildDiffEditorWordWrapOptions(
  diffWordWrap: boolean | undefined
): Pick<
  editor.IStandaloneDiffEditorConstructionOptions,
  'wordWrap' | 'diffWordWrap' | 'useInlineViewWhenSpaceIsLimited'
> {
  const wordWrap = resolveDiffEditorWordWrap(diffWordWrap)
  return {
    wordWrap,
    diffWordWrap: wordWrap,
    // Why: Monaco may collapse side-by-side to inline when narrow, then leave
    // original.wordWrapOverride2 stuck at 'off' so only the right pane wraps.
    useInlineViewWhenSpaceIsLimited: false
  }
}

export function applyDiffEditorWordWrapOptions(
  diffEditor: editor.IStandaloneDiffEditor,
  diffWordWrap: boolean | undefined
): Disposable {
  const wordWrap = resolveDiffEditorWordWrap(diffWordWrap)
  const originalEditor = diffEditor.getOriginalEditor()
  const modifiedEditor = diffEditor.getModifiedEditor()

  const reapplyIfNeeded = (): void => {
    for (const codeEditor of [originalEditor, modifiedEditor]) {
      const raw = codeEditor.getRawOptions()
      // Why: after inline collapse/expand, Monaco can leave wordWrapOverride2 at
      // 'off' on the original editor; re-assert inherit so wordWrap applies.
      if (raw.wordWrap !== wordWrap || raw.wordWrapOverride2 !== 'inherit') {
        codeEditor.updateOptions({ wordWrap, wordWrapOverride2: 'inherit' })
      }
    }
  }

  reapplyIfNeeded()

  // Why: @monaco-editor/react re-applies parent options on re-render, and Monaco
  // may rewrite wrap overrides when toggling side-by-side; re-assert both panes.
  const originalOptionsSub = originalEditor.onDidChangeConfiguration(reapplyIfNeeded)
  const modifiedOptionsSub = modifiedEditor.onDidChangeConfiguration(reapplyIfNeeded)

  return {
    dispose: () => {
      originalOptionsSub.dispose()
      modifiedOptionsSub.dispose()
    }
  }
}
