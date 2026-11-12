import type { typescript } from 'monaco-editor'

export function configureMonacoTypeScriptDefaults(language: typeof typescript): void {
  for (const defaults of [language.typescriptDefaults, language.javascriptDefaults]) {
    // Sandboxed imports and concatenated inline diffs cannot produce useful project diagnostics.
    defaults.setDiagnosticsOptions({
      noSemanticValidation: true,
      noSuggestionDiagnostics: true,
      noSyntaxValidation: true
    })
    defaults.setModeConfiguration({ ...defaults.modeConfiguration, diagnostics: false })
    // Preserve JSX parsing without emission for TSX/JSX models.
    defaults.setCompilerOptions({
      ...defaults.getCompilerOptions(),
      jsx: language.JsxEmit.Preserve
    })
  }
}
