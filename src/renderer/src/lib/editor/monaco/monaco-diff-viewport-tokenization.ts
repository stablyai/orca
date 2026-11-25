import type * as Monaco from 'monaco-editor'

// Eager tokenizing costs up to the last visible line; deeper panes keep Monaco's idle tokenizer.
const MAX_EAGER_TOKENIZED_LINE = 1_000

// Outer-scrolled diff panes never scroll themselves, so publish their viewport before first render.
export function installMonacoDiffViewportTokenization(monaco: typeof Monaco): void {
  monaco.editor.onDidCreateDiffEditor((diffEditor) => {
    for (const pane of [diffEditor.getOriginalEditor(), diffEditor.getModifiedEditor()]) {
      const tokenizeVisibleLines = (): void => {
        const lastVisibleLine = pane.getVisibleRanges().at(-1)?.endLineNumber ?? 0
        if (lastVisibleLine <= MAX_EAGER_TOKENIZED_LINE) {
          pane.handleInitialized?.()
        }
      }
      pane.onDidChangeModel(tokenizeVisibleLines)
      pane.onDidChangeHiddenAreas(tokenizeVisibleLines)
      pane.onDidLayoutChange(tokenizeVisibleLines)
    }
  })
}
