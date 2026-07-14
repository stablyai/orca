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

// Why: Monaco only bundles its VS themes. Register Dracula here so every file,
// diff, and notebook editor can resolve the same persisted theme name.
monaco.editor.defineTheme('orca-dracula', {
  base: 'vs-dark',
  inherit: true,
  rules: [
    { token: 'comment', foreground: '6272A4', fontStyle: 'italic' },
    { token: 'string', foreground: 'F1FA8C' },
    { token: 'number', foreground: 'BD93F9' },
    { token: 'regexp', foreground: 'F1FA8C' },
    { token: 'keyword', foreground: 'FF79C6' },
    { token: 'operator', foreground: 'FF79C6' },
    { token: 'type', foreground: '8BE9FD', fontStyle: 'italic' },
    { token: 'type.identifier', foreground: '8BE9FD', fontStyle: 'italic' },
    { token: 'function', foreground: '50FA7B' },
    { token: 'variable.predefined', foreground: 'BD93F9', fontStyle: 'italic' },
    { token: 'tag', foreground: 'FF79C6' },
    { token: 'attribute.name', foreground: '50FA7B' },
    { token: 'attribute.value', foreground: 'F1FA8C' }
  ],
  colors: {
    'editor.background': '#282A36',
    'editor.foreground': '#F8F8F2',
    'editorLineNumber.foreground': '#6272A4',
    'editor.selectionBackground': '#44475A',
    'editor.selectionHighlightBackground': '#424450',
    'editor.lineHighlightBorder': '#44475A',
    'editor.findMatchBackground': '#FFB86CCC',
    'editor.findMatchHighlightBackground': '#FFFFFF66',
    'editorCursor.foreground': '#F8F8F2',
    'editorWhitespace.foreground': '#FFFFFF1A',
    'editorIndentGuide.background1': '#FFFFFF1A',
    'editorIndentGuide.activeBackground1': '#FFFFFF73'
  }
})

// Configure Monaco to use the locally bundled editor instead of CDN
loader.config({ monaco })

// Re-export for convenience
export { monaco }
