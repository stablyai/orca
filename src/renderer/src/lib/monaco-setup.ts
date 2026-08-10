import { loader } from '@monaco-editor/react'
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker'
import jsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker'
import cssWorker from 'monaco-editor/esm/vs/language/css/css.worker?worker'
import htmlWorker from 'monaco-editor/esm/vs/language/html/html.worker?worker'
import tsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker'
import { loadMonacoNlsForUiLocale } from './monaco-nls'

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

// Why: nls.messages.* must land on globalThis before monaco-editor evaluates
// contribution modules that call localize() for action/context-menu labels.
await loadMonacoNlsForUiLocale()

const monaco = await import('monaco-editor')
const { typescript: monacoTS } = monaco
await import('monaco-editor/min/vs/editor/editor.main.css')

const { registerAstroLanguage } = await import('./monaco-languages/register-astro')
const { registerJsonlLanguage } = await import('./monaco-languages/register-jsonl')
const { registerNimLanguage } = await import('./monaco-languages/register-nim')
const { registerSvelteLanguage } = await import('./monaco-languages/register-svelte')
const { registerVueLanguage } = await import('./monaco-languages/register-vue')
const { installMonacoDelayerCancellationGuard } =
  await import('./monaco-delayer-cancellation-guard')
const { installMonacoDiffEditorDisposalGuard } = await import('./monaco-diff-editor-disposal')
const { installMonacoPeekReferencesPreviewOptions } = await import('./monaco-peek-preview-options')
const { installMonacoContextMenuPaste } =
  await import('@/components/editor/install-monaco-context-menu-paste')

// Why: Monaco here is a viewer/diff surface, not a type checker — users edit
// real code in their own IDE. The sandboxed TS worker cannot resolve imports
// to project files, so semantic validation produces a long tail of false
// positives (unresolved modules 2307/2792, unused-import fades 6133/6138/
// 6192/6196/6198/6205, missing names 2304/2305, bogus type mismatches 2322/
// 2339/2345/2571/2724, implicit-any 7006/7016/7026/7031/7053/18046/18048).
// Syntax validation is also noisy in the diff viewer: with `renderSideBySide`
// off (or during partial hunks), Monaco feeds the worker concatenated
// original+modified text that isn't a valid TS program, producing fake
// parse errors like "',' expected (1005)". Disable all three categories —
// we keep tokenization (colorization) which is what actually gives useful
// reading affordance here.
const diagnosticsOptions = {
  noSemanticValidation: true,
  noSuggestionDiagnostics: true,
  noSyntaxValidation: true
}
monacoTS.typescriptDefaults.setDiagnosticsOptions(diagnosticsOptions)
monacoTS.javascriptDefaults.setDiagnosticsOptions(diagnosticsOptions)

// Why: .tsx/.jsx files share the base 'typescript'/'javascript' language ids
// in Monaco's registry (there is no separate 'typescriptreact' id), so the
// compiler options on those defaults apply to both. Without jsx enabled, the
// worker raises TS17004 "Cannot use JSX unless the '--jsx' flag is provided"
// on every JSX tag. Preserve mode is enough to allow parsing without forcing
// an emit transform (we never emit — this is a read-only language service).
monacoTS.typescriptDefaults.setCompilerOptions({
  ...monacoTS.typescriptDefaults.getCompilerOptions(),
  jsx: monacoTS.JsxEmit.Preserve
})
monacoTS.javascriptDefaults.setCompilerOptions({
  ...monacoTS.javascriptDefaults.getCompilerOptions(),
  jsx: monacoTS.JsxEmit.Preserve
})

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

export { monaco }
