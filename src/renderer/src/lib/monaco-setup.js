import { loader } from '@monaco-editor/react';
import * as monaco from 'monaco-editor';
import { typescript as monacoTS } from 'monaco-editor';
import 'monaco-editor/min/vs/editor/editor.main.css';
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import jsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker';
import cssWorker from 'monaco-editor/esm/vs/language/css/css.worker?worker';
import htmlWorker from 'monaco-editor/esm/vs/language/html/html.worker?worker';
import tsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker';
globalThis.MonacoEnvironment = {
    getWorker(_workerId, label) {
        switch (label) {
            case 'json':
                return new jsonWorker();
            case 'css':
            case 'scss':
            case 'less':
                return new cssWorker();
            case 'html':
            case 'handlebars':
            case 'razor':
                return new htmlWorker();
            case 'typescript':
            case 'typescriptreact':
            case 'javascript':
            case 'javascriptreact':
                return new tsWorker();
            default:
                return new editorWorker();
        }
    }
};
// Why: Monaco's built-in TypeScript worker runs in isolation without filesystem
// access, so it cannot resolve imports to project files that aren't open as
// editor models. This produces false "Cannot find module" diagnostics for every
// import statement. Ignoring specific TS diagnostic codes (e.g., 2307, 2792)
// removes this noise while keeping type checking, auto-complete, and basic
// validation fully functional for local symbols.
monacoTS.typescriptDefaults.setDiagnosticsOptions({
    diagnosticCodesToIgnore: [2307, 2792]
});
monacoTS.javascriptDefaults.setDiagnosticsOptions({
    diagnosticCodesToIgnore: [2307, 2792]
});
// Configure Monaco to use the locally bundled editor instead of CDN
loader.config({ monaco });
// Re-export for convenience
export { monaco };
