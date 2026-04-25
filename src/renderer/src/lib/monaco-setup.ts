import { loader } from '@monaco-editor/react'
import * as monaco from 'monaco-editor'
import { typescript as monacoTS } from 'monaco-editor'
import 'monaco-editor/min/vs/editor/editor.main.css'
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker'
import jsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker'
import cssWorker from 'monaco-editor/esm/vs/language/css/css.worker?worker'
import htmlWorker from 'monaco-editor/esm/vs/language/html/html.worker?worker'
import tsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker'
import { registerVueLanguage } from './monaco-languages/register-vue'

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

// Why: Monaco's built-in TypeScript worker runs in isolation without filesystem
// access, so it cannot resolve imports to project files that aren't open as
// editor models. This produces false "Cannot find module" diagnostics for every
// import statement (2307/2792) and false "unused import/local" diagnostics
// (6133/6138/6192/6196/6198/6205) because cross-file references are invisible
// to the worker. Those "unused" diagnostics carry the `reportsUnnecessary` tag,
// which Monaco renders by fading the identifier to 0.667 opacity via
// `.squiggly-inline-unnecessary` — in a diff view that looks like Orca's
// diff renderer is muting lines. Disable suggestion diagnostics entirely
// (where most of these originate) and ignore the specific error codes that
// still fire as semantic diagnostics. Keep syntax + semantic validation on
// so genuine parse errors and type mismatches in the open model still surface.
const diagnosticsOptions = {
  noSuggestionDiagnostics: true,
  diagnosticCodesToIgnore: [
    2307, // Cannot find module
    2792, // Cannot find module (did you mean …)
    6133, // 'x' is declared but its value is never read
    6138, // Property 'x' is declared but its value is never read
    6192, // All imports in import declaration are unused
    6196, // 'x' is declared but never used
    6198, // All destructured elements are unused
    6205, // All type parameters are unused
    6385 // 'x' is deprecated
  ]
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

// Configure Monaco to use the locally bundled editor instead of CDN
loader.config({ monaco })

// Re-export for convenience
export { monaco }
