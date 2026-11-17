import type * as Monaco from 'monaco-editor'
import {
  DefinitionAdapter,
  LibFiles
} from 'monaco-editor/esm/vs/language/typescript/languageFeatures.js'
import { useAppStore } from '@/store/index'
import { findImportReferenceAt } from '../../../../../../shared/editor-navigation/import-reference-scan'
import { openImportTarget } from './import-navigation-open'
import { findImportNavigationSource, type ImportNavigationSource } from './import-navigation-source'

// Targets get their own scheme so they never collide with the models of open tabs.
const TARGET_SCHEME = 'orca-import-target'
const MAX_TARGET_MODELS = 8

type MonacoApi = typeof Monaco
type TypeScriptApi = MonacoApi['typescript']
type Location = Monaco.languages.Location | Monaco.languages.LocationLink

const targets = new Map<string, { filePath: string; source: ImportNavigationSource }>()

function targetModel(
  monaco: MonacoApi,
  source: ImportNavigationSource,
  filePath: string,
  content: string
): Monaco.editor.ITextModel {
  const uri = monaco.Uri.from({
    scheme: TARGET_SCHEME,
    path: filePath.startsWith('/') ? filePath : `/${filePath}`,
    // Why the owner: the same path on two hosts is two files, and must not share one preview.
    query: source.ownerKey
  })
  const key = uri.toString()
  const existing = monaco.editor.getModel(uri)
  // Re-insert so the map stays ordered by last use.
  targets.delete(key)
  targets.set(key, { filePath, source })
  if (existing) {
    if (existing.getValue() !== content) {
      existing.setValue(content)
    }
    return existing
  }
  for (const stale of [...targets.keys()].slice(0, -MAX_TARGET_MODELS)) {
    monaco.editor.getModel(monaco.Uri.parse(stale))?.dispose()
    targets.delete(stale)
  }
  // Why plaintext: the model only feeds Monaco's hover preview, and must not enter the TypeScript worker.
  return monaco.editor.createModel(content, 'plaintext', uri)
}

async function importDefinition(
  monaco: MonacoApi,
  model: Monaco.editor.ITextModel,
  position: Monaco.Position,
  builtIn: readonly Location[]
): Promise<Location | null> {
  const modelUri = model.uri.toString()
  // TypeScript resolves an imported name to its binding in this file; that binding names the module.
  const binding =
    builtIn.length === 1 && builtIn[0].uri.toString() === modelUri ? builtIn[0].range : null
  const offset = model.getOffsetAt(
    binding ? { lineNumber: binding.startLineNumber, column: binding.startColumn } : position
  )
  // Without that confirmation only a module path string counts; the scanner alone cannot tell a
  // real binding from text that merely looks like one.
  const reference = findImportReferenceAt(model.getValue(), offset, { specifierOnly: !binding })
  const source = reference && findImportNavigationSource(useAppStore.getState(), modelUri)
  if (!reference || !source) {
    return null
  }
  const target = await source.resolve(reference, source.file.filePath)
  if (!target || model.isDisposed() || !source.isCurrent(useAppStore.getState())) {
    return null
  }
  const word = model.getWordAtPosition(position)
  return {
    uri: targetModel(monaco, source, target.filePath, target.content).uri,
    range: new monaco.Range(target.line, target.column, target.line, target.column),
    ...(word
      ? {
          originSelectionRange: new monaco.Range(
            position.lineNumber,
            word.startColumn,
            position.lineNumber,
            word.endColumn
          )
        }
      : {})
  }
}

/** Go to Definition on an imported name or module path opens the file that declares it. */
export function installMonacoImportDefinitionNavigation(monaco: MonacoApi): void {
  const typescript: TypeScriptApi = monaco.typescript
  const languages = [
    ['typescript', typescript.typescriptDefaults, typescript.getTypeScriptWorker],
    ['javascript', typescript.javascriptDefaults, typescript.getJavaScriptWorker]
  ] as const
  for (const [languageId, defaults, getWorker] of languages) {
    // Why replace the built-in provider: it answers an imported name with the import line itself, and two
    // answers would turn every jump into a peek list. This provider still returns its answer otherwise.
    defaults.setModeConfiguration({ ...defaults.modeConfiguration, definitions: false })
    const worker = async (...uris: Monaco.Uri[]) => (await getWorker())(...uris)
    const builtInProvider = new DefinitionAdapter(new LibFiles(worker), worker)
    monaco.languages.registerDefinitionProvider(languageId, {
      async provideDefinition(model, position, token) {
        const builtIn = (await builtInProvider.provideDefinition(model, position, token)) ?? []
        if (token.isCancellationRequested || model.isDisposed()) {
          return builtIn
        }
        try {
          const target = await importDefinition(monaco, model, position, builtIn)
          return target ? [target] : builtIn
        } catch {
          return builtIn
        }
      }
    })
  }
  monaco.editor.registerEditorOpener({
    openCodeEditor(_sourceEditor, resource, selectionOrPosition) {
      const target = targets.get(resource.toString())
      if (!target) {
        return false
      }
      const line =
        selectionOrPosition && 'startLineNumber' in selectionOrPosition
          ? selectionOrPosition.startLineNumber
          : (selectionOrPosition?.lineNumber ?? 1)
      const column =
        selectionOrPosition && 'startColumn' in selectionOrPosition
          ? selectionOrPosition.startColumn
          : (selectionOrPosition?.column ?? 1)
      return openImportTarget(target.source, target.filePath, line, column)
    }
  })
}
