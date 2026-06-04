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
import { registerSvelteLanguage } from './monaco-languages/register-svelte'
import { registerVueLanguage } from './monaco-languages/register-vue'
import { installMonacoDiffEditorDisposalGuard } from './monaco-diff-editor-disposal'
import { registerCodeIntelProviders } from './monaco-code-intel-providers'
import { resolveCodeIntelWorktree, isCodeIntelEnabled } from './code-intel-editor-context'
import { installCodeIntelStoreBinding } from './code-intel-store-binding'
import { setTypeScriptNavigationMode } from './monaco-typescript-navigation-mode'

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

// Why: the code-intel experiment defaults off. Keep Monaco's built-in TS/JS
// navigation alive until the store binding disables it while the sidecar is on.
setTypeScriptNavigationMode(false)

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
registerCodeIntelProviders(resolveCodeIntelWorktree, isCodeIntelEnabled)
installCodeIntelStoreBinding()
installMonacoDiffEditorDisposalGuard(monaco)

// Configure Monaco to use the locally bundled editor instead of CDN
loader.config({ monaco })

// Why: mirrors window.__store — lets e2e preview specs drive Monaco via its public
// API (trigger commands, add decorations) without fighting synthetic event routing.
// Safe in Electron: the renderer has no external web context to worry about.
if (typeof window !== 'undefined') {
  ;(window as unknown as Record<string, unknown>).__monaco = monaco
}

// Re-export for convenience
export { monaco }
