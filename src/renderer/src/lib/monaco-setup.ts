import { loader } from '@monaco-editor/react'
import * as monaco from 'monaco-editor'
import { typescript as monacoTS } from 'monaco-editor'
import 'monaco-editor/min/vs/editor/editor.main.css'
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker'
import jsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker'
import cssWorker from 'monaco-editor/esm/vs/language/css/css.worker?worker'
import htmlWorker from 'monaco-editor/esm/vs/language/html/html.worker?worker'
import tsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker'
import { registerAstroLanguage } from './monaco-languages/register-astro'
import { registerJsonlLanguage } from './monaco-languages/register-jsonl'
import { registerNimLanguage } from './monaco-languages/register-nim'
import { registerSvelteLanguage } from './monaco-languages/register-svelte'
import { registerVueLanguage } from './monaco-languages/register-vue'
import { installMonacoDelayerCancellationGuard } from './monaco-delayer-cancellation-guard'
import { installMonacoDiffEditorDisposalGuard } from './monaco-diff-editor-disposal'
import { installMonacoPeekReferencesPreviewOptions } from './monaco-peek-preview-options'
import { installMonacoContextMenuPaste } from '@/components/editor/install-monaco-context-menu-paste'

globalThis.MonacoEnvironment = {
  getWorker(_workerId, label) {
    switch (label) {
      case 'json':
        return new jsonWorker()
      case 'css':
      case 'scss':
      case 'less':
        return new cssWorker()
      case 'html':
      case 'handlebars':
      case 'razor':
        return new htmlWorker()
      case 'typescript':
      case 'javascript':
        return new tsWorker()
      default:
        return new editorWorker()
    }
  }
}

// Why: Monaco remains a quiet editor surface, not Orca's source of diagnostics.
// Edit tabs now hydrate bounded TS/JS workspace models for hover/definition,
// but diff and partial-hunk surfaces can still produce noisy false positives.
const diagnosticsOptions = {
  noSemanticValidation: true,
  noSuggestionDiagnostics: true,
  noSyntaxValidation: true
}
monacoTS.typescriptDefaults.setDiagnosticsOptions(diagnosticsOptions)
monacoTS.javascriptDefaults.setDiagnosticsOptions(diagnosticsOptions)
const typeScriptModeConfiguration = {
  completionItems: true,
  hovers: false,
  documentSymbols: true,
  definitions: false,
  references: true,
  documentHighlights: true,
  rename: true,
  diagnostics: false,
  documentRangeFormattingEdits: true,
  signatureHelp: true,
  onTypeFormattingEdits: true,
  codeActions: true,
  inlayHints: true
}
monacoTS.typescriptDefaults.setModeConfiguration(typeScriptModeConfiguration)
monacoTS.javascriptDefaults.setModeConfiguration(typeScriptModeConfiguration)

// Why: .tsx/.jsx files share the base 'typescript'/'javascript' language ids
// in Monaco's registry (there is no separate 'typescriptreact' id), so the
// compiler options on those defaults apply to both. Without jsx enabled, the
// worker raises TS17004 "Cannot use JSX unless the '--jsx' flag is provided"
// on every JSX tag. Preserve mode is enough to allow parsing without forcing
// an emit transform (we never emit — this is a read-only language service).
monacoTS.typescriptDefaults.setCompilerOptions({
  ...monacoTS.typescriptDefaults.getCompilerOptions(),
  allowJs: true,
  allowNonTsExtensions: true,
  jsx: monacoTS.JsxEmit.Preserve,
  moduleResolution: monacoTS.ModuleResolutionKind.NodeJs,
  noEmit: true
})
monacoTS.javascriptDefaults.setCompilerOptions({
  ...monacoTS.javascriptDefaults.getCompilerOptions(),
  allowJs: true,
  allowNonTsExtensions: true,
  checkJs: false,
  jsx: monacoTS.JsxEmit.Preserve
})
monacoTS.typescriptDefaults.setEagerModelSync(true)
monacoTS.javascriptDefaults.setEagerModelSync(true)

registerVueLanguage(monaco)
registerSvelteLanguage(monaco)
registerAstroLanguage(monaco)
registerNimLanguage(monaco)
registerJsonlLanguage(monaco)
installMonacoDelayerCancellationGuard()
installMonacoDiffEditorDisposalGuard(monaco)
installMonacoPeekReferencesPreviewOptions()
// Why: Monaco's built-in context-menu Paste reads navigator.clipboard, which is
// blocked in Orca's sandboxed renderer. Route it through the trusted IPC bridge
// so right-click Paste works like Cmd+V (which already works via native events).
installMonacoContextMenuPaste(monaco)

// Configure Monaco to use the locally bundled editor instead of CDN
loader.config({ monaco })

// Re-export for convenience
export { monaco }
