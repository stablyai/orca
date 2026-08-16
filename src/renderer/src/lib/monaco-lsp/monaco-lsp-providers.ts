import type * as MonacoNamespace from 'monaco-editor'
import type { IDisposable, IPosition, IRange, editor, languages } from 'monaco-editor'
import { relativePathInsideRoot } from '../../../../shared/cross-platform-path'
import { detectLanguage } from '@/lib/language-detect'
import { useAppStore } from '@/store'
import {
  LSP_MARKER_OWNER,
  fileUriToPath,
  lspCompletionToMonaco,
  lspDefinitionToLocations,
  lspDiagnosticsToMonacoMarkers,
  lspHoverToMonaco,
  toLspPosition
} from './lsp-monaco-conversion'
import {
  flushPendingLspChange,
  getLspEntriesForSessionDocument,
  getLspEntryForModelUri
} from './monaco-lsp-documents'
import type { LspDocumentEntry } from './monaco-lsp-documents'

type MonacoApi = typeof MonacoNamespace

let providerMonaco: MonacoApi | null = null
let disposables: IDisposable[] = []
let unsubscribeDiagnostics: (() => void) | null = null
const registeredLanguages = new Set<string>()

async function requestForModel(
  model: editor.ITextModel,
  position: IPosition,
  method:
    | 'textDocument/hover'
    | 'textDocument/definition'
    | 'textDocument/references'
    | 'textDocument/completion',
  extraParams?: Record<string, unknown>
): Promise<{ entry: LspDocumentEntry; result: unknown } | null> {
  const entry = getLspEntryForModelUri(model.uri.toString())
  if (!entry) {
    return null
  }
  try {
    await flushPendingLspChange(entry)
    const result = await window.api.lsp.request({
      sessionId: entry.sessionId,
      method,
      params: {
        textDocument: { uri: entry.fileUri },
        position: toLspPosition(position),
        ...extraParams
      }
    })
    return { entry, result }
  } catch {
    // Why: a dead or slow server must never break plain editing; features
    // simply don't answer.
    return null
  }
}

/** LSP locations → Monaco locations; same-file hits reuse the live model's
 *  URI so navigation stays within the current surface. */
function toMonacoLocations(
  monaco: MonacoApi,
  model: editor.ITextModel,
  entry: LspDocumentEntry,
  result: unknown
): { uri: editor.ITextModel['uri']; range: IRange }[] {
  // Why: compare path-of-URI to path-of-URI — entry.filePath is the raw
  // renderer path, while server locations echo main's realpath'd fileUri
  // (symlinked roots, Windows drive casing).
  const entryPath = fileUriToPath(entry.fileUri)
  return lspDefinitionToLocations(result).map((location) => ({
    uri: fileUriToPath(location.uri) === entryPath ? model.uri : monaco.Uri.parse(location.uri),
    range: location.range
  }))
}

function openDefinitionTarget(
  source: editor.ICodeEditor,
  resource: { toString: () => string },
  selectionOrPosition: IRange | IPosition
): boolean {
  const sourceModelUri = source.getModel()?.uri.toString()
  const entry = sourceModelUri ? getLspEntryForModelUri(sourceModelUri) : null
  const absolutePath = fileUriToPath(resource.toString())
  if (!entry || !absolutePath) {
    return false
  }
  const relativePath = relativePathInsideRoot(entry.rootPath, absolutePath)
  if (relativePath === null || relativePath === '') {
    return false
  }
  const line =
    'startLineNumber' in selectionOrPosition
      ? selectionOrPosition.startLineNumber
      : selectionOrPosition.lineNumber
  const column =
    'startColumn' in selectionOrPosition
      ? selectionOrPosition.startColumn
      : selectionOrPosition.column
  useAppStore.getState().openFile({
    filePath: absolutePath,
    relativePath,
    worktreeId: entry.worktreeId,
    language: detectLanguage(relativePath),
    mode: 'edit'
  })
  // Why: match search/annotation navigation — the destination editor mounts
  // asynchronously, so hand the reveal off after it owns layout.
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      useAppStore
        .getState()
        .setPendingEditorReveal({ filePath: absolutePath, line, column, matchLength: 0 })
    })
  })
  return true
}

function ensureGlobalLspWiring(monaco: MonacoApi): void {
  disposables.push(
    monaco.editor.registerEditorOpener({
      openCodeEditor: (source, resource, selectionOrPosition) =>
        selectionOrPosition ? openDefinitionTarget(source, resource, selectionOrPosition) : false
    })
  )
  try {
    const unsubscribe = window.api.lsp.onDiagnostics((payload) => {
      const entries = getLspEntriesForSessionDocument(payload.sessionId, payload.fileUri)
      if (entries.length === 0) {
        return
      }
      const markers = lspDiagnosticsToMonacoMarkers(payload.diagnostics, monaco.MarkerSeverity)
      for (const entry of entries) {
        if (!entry.model.isDisposed()) {
          monaco.editor.setModelMarkers(entry.model, LSP_MARKER_OWNER, markers)
        }
      }
    })
    if (typeof unsubscribe === 'function') {
      unsubscribeDiagnostics = unsubscribe
    }
  } catch {
    // Why: surfaces without the lsp bridge (web fallback) just skip diagnostics.
  }
}

/** Register LSP-backed language features once per language id. Called only
 *  after a document successfully opened, so unsupported setups register nothing. */
export function ensureLspSupportForLanguage(monaco: MonacoApi, languageId: string): void {
  if (providerMonaco !== monaco) {
    // Why: a re-created Monaco (window reload) makes old registrations stale.
    for (const disposable of disposables) {
      disposable.dispose()
    }
    disposables = []
    registeredLanguages.clear()
    unsubscribeDiagnostics?.()
    unsubscribeDiagnostics = null
    providerMonaco = monaco
    ensureGlobalLspWiring(monaco)
  }
  if (registeredLanguages.has(languageId)) {
    return
  }
  registeredLanguages.add(languageId)

  disposables.push(
    monaco.languages.registerHoverProvider(languageId, {
      provideHover: async (model, position) => {
        const response = await requestForModel(model, position, 'textDocument/hover')
        return response ? lspHoverToMonaco(response.result) : null
      }
    }),
    monaco.languages.registerDefinitionProvider(languageId, {
      provideDefinition: async (model, position) => {
        const response = await requestForModel(model, position, 'textDocument/definition')
        return response ? toMonacoLocations(monaco, model, response.entry, response.result) : null
      }
    }),
    monaco.languages.registerReferenceProvider(languageId, {
      provideReferences: async (model, position) => {
        const response = await requestForModel(model, position, 'textDocument/references', {
          context: { includeDeclaration: true }
        })
        return response ? toMonacoLocations(monaco, model, response.entry, response.result) : null
      }
    }),
    monaco.languages.registerCompletionItemProvider(languageId, {
      triggerCharacters: ['.', '"', "'", '/', '@', ':'],
      provideCompletionItems: async (model, position) => {
        const response = await requestForModel(model, position, 'textDocument/completion')
        if (!response) {
          return { suggestions: [] }
        }
        const word = model.getWordUntilPosition(position)
        const defaultRange: IRange = {
          startLineNumber: position.lineNumber,
          startColumn: word.startColumn,
          endLineNumber: position.lineNumber,
          endColumn: position.column
        }
        const converted = lspCompletionToMonaco(response.result, defaultRange, {
          kinds: monaco.languages.CompletionItemKind as unknown as Record<string, number>,
          snippetRule: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet
        })
        return {
          // Why: the converter emits numeric enum values so it stays node-testable;
          // the shapes are structurally identical to Monaco's CompletionItem.
          suggestions: converted.suggestions as unknown as languages.CompletionItem[],
          incomplete: converted.incomplete
        }
      }
    })
  )
}

export function clearLspMarkers(monaco: MonacoApi, model: editor.ITextModel): void {
  monaco.editor.setModelMarkers(model, LSP_MARKER_OWNER, [])
}
