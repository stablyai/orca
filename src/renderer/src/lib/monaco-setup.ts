import { loader } from '@monaco-editor/react'
import { editorModelRegistry } from './editor-model-registry'
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
import { registerLeanLanguage } from './monaco-languages/register-lean'
import { registerNimLanguage } from './monaco-languages/register-nim'
import { registerQuartoLanguage } from './monaco-languages/register-quarto'
import { registerShellMarkdownAliases } from './monaco-languages/register-shell-markdown-aliases'
import { registerSvelteLanguage } from './monaco-languages/register-svelte'
import { registerTypstLanguage } from './monaco-languages/register-typst'
import { registerVueLanguage } from './monaco-languages/register-vue'
import { registerZigLanguage } from './monaco-languages/register-zig'
import { installMonacoDelayerCancellationGuard } from './monaco-delayer-cancellation-guard'
import { installMonacoDiffEditorDisposalGuard } from './monaco-diff-editor-disposal'
import { installMonacoPeekReferencesPreviewOptions } from './monaco-peek-preview-options'
import { installMonacoContextMenuPaste } from '@/components/editor/install-monaco-context-menu-paste'
import { runMonacoSetupSteps } from './monaco-setup-steps'

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

// Sandboxed workers cannot resolve project imports, and inline diffs can concatenate invalid programs; disable diagnostic categories while retaining useful tokenization.
const diagnosticsOptions = {
  noSemanticValidation: true,
  noSuggestionDiagnostics: true,
  noSyntaxValidation: true
}
monacoTS.typescriptDefaults.setDiagnosticsOptions(diagnosticsOptions)
monacoTS.javascriptDefaults.setDiagnosticsOptions(diagnosticsOptions)

// TSX/JSX share TypeScript/JavaScript defaults; preserve JSX parsing without emission to avoid TS17004 on tags.
monacoTS.typescriptDefaults.setCompilerOptions({
  ...monacoTS.typescriptDefaults.getCompilerOptions(),
  jsx: monacoTS.JsxEmit.Preserve
})
monacoTS.javascriptDefaults.setCompilerOptions({
  ...monacoTS.javascriptDefaults.getCompilerOptions(),
  jsx: monacoTS.JsxEmit.Preserve
})

runMonacoSetupSteps([
  ['Vue language registration', () => registerVueLanguage(monaco)],
  ['Svelte language registration', () => registerSvelteLanguage(monaco)],
  ['Astro language registration', () => registerAstroLanguage(monaco)],
  ['Nim language registration', () => registerNimLanguage(monaco)],
  ['Lean language registration', () => registerLeanLanguage(monaco)],
  ['Typst language registration', () => registerTypstLanguage(monaco)],
  ['Zig language registration', () => registerZigLanguage(monaco)],
  ['JSONL language registration', () => registerJsonlLanguage(monaco)],
  ['Quarto language registration', () => registerQuartoLanguage(monaco)],
  ['shell Markdown alias registration', () => registerShellMarkdownAliases(monaco)],
  ['delayer cancellation guard', installMonacoDelayerCancellationGuard],
  ['diff editor disposal guard', () => installMonacoDiffEditorDisposalGuard(monaco)],
  ['peek references preview options', installMonacoPeekReferencesPreviewOptions],
  // Sandboxed navigator.clipboard blocks Monaco Paste; use trusted IPC as native Cmd+V does.
  ['context-menu paste', () => installMonacoContextMenuPaste(monaco)]
])

loader.config({ monaco })

const unregisterEditorModelRegistry = editorModelRegistry.register(monaco)
if (import.meta.hot) {
  import.meta.hot.dispose(unregisterEditorModelRegistry)
}
export { monaco }
