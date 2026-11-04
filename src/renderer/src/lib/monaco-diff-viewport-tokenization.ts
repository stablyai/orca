import type * as Monaco from 'monaco-editor'

// Combined-diff panes are as tall as their file, so larger spans keep Monaco's incremental idle
// tokenization instead of repainting thousands of coloured lines in one frame.
const MAX_EAGER_TOKENIZED_LINES = 1_000

function countVisibleLines(pane: Monaco.editor.ICodeEditor): number {
  return pane
    .getVisibleRanges()
    .reduce((total, range) => total + range.endLineNumber - range.startLineNumber + 1, 0)
}

// Standalone Monaco tokenizes visible lines only when a pane scrolls itself, so outer-scrolled
// and newly mounted diff panes would paint uncoloured until idle tokenization catches up.
export function installMonacoDiffViewportTokenization(monaco: typeof Monaco): void {
  monaco.editor.onDidCreateDiffEditor((diffEditor) => {
    for (const pane of [diffEditor.getOriginalEditor(), diffEditor.getModifiedEditor()]) {
      const tokenizeVisibleLines = (): void => {
        if (countVisibleLines(pane) <= MAX_EAGER_TOKENIZED_LINES) {
          pane.handleInitialized?.()
        }
      }
      // Pane disposal drops these listeners with its emitters.
      pane.onDidChangeModel(tokenizeVisibleLines)
      pane.onDidChangeHiddenAreas(tokenizeVisibleLines)
      pane.onDidLayoutChange(tokenizeVisibleLines)
    }
  })
}
