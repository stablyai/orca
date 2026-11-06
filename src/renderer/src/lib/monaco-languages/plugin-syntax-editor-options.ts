import * as monaco from 'monaco-editor/esm/vs/editor/editor.api.js'

/** Plugin syntaxes paint through semantic tokens, which standalone themes leave off. Monaco
 *  applies this global option from any editor, including diff editors, whose option types omit it. */
export const PLUGIN_SYNTAX_EDITOR_OPTIONS: monaco.editor.IGlobalEditorOptions = {
  'semanticHighlighting.enabled': true
}

/**
 * Puts kept models on the editor's language. @monaco-editor/react reuses a kept model without
 * resetting its language and drops a language change that arrives before the editor is ready, so
 * a reopened plugin-highlighted tab would otherwise stay on the plain text it was moved to.
 */
export function applyModelLanguage(
  models: readonly (monaco.editor.ITextModel | null | undefined)[],
  language: string
): void {
  for (const model of models) {
    if (model && !model.isDisposed() && model.getLanguageId() !== language) {
      monaco.editor.setModelLanguage(model, language)
    }
  }
}
