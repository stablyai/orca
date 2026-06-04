import { typescript as monacoTS } from 'monaco-editor'

export function buildTypeScriptNavigationModeConfig(
  codeIntelEnabled: boolean
): monacoTS.ModeConfiguration {
  const useMonacoNavigation = !codeIntelEnabled
  // Why: setModeConfiguration replaces the whole language config, so the
  // features we keep must stay explicit when toggling definitions/references.
  return {
    completionItems: true,
    hovers: true,
    documentSymbols: true,
    definitions: useMonacoNavigation,
    references: useMonacoNavigation,
    documentHighlights: true,
    rename: true,
    diagnostics: false,
    documentRangeFormattingEdits: true,
    signatureHelp: true,
    onTypeFormattingEdits: true,
    codeActions: true,
    inlayHints: true
  }
}

export function setTypeScriptNavigationMode(codeIntelEnabled: boolean): void {
  const modeConfig = buildTypeScriptNavigationModeConfig(codeIntelEnabled)
  monacoTS.typescriptDefaults.setModeConfiguration(modeConfig)
  monacoTS.javascriptDefaults.setModeConfiguration(modeConfig)
}
