import type * as Monaco from 'monaco-editor'
import {
  DefinitionAdapter,
  LibFiles
} from 'monaco-editor/esm/vs/language/typescript/languageFeatures.js'
import { useAppStore } from '@/store/index'
import { scheduleEditorLineReveal } from '@/store/slices/editor/focus/editor-focus-reveal'
import { getRuntimeTargetForFileOwner } from '@/lib/files/access/file-owner-runtime-target'
import { getRelativePathInsideRoot } from '@/lib/path'
import { detectLanguage } from '../../../../../shared/editor-language/editor-language-detect'
import {
  findImportNavigationRequest,
  scanImportStatements,
  type ImportNavigationRequest
} from '../import-navigation/import-statement-scan'
import { resolveImportNavigationTarget } from '../import-navigation/import-target-resolution'
import {
  createOpenFileImportNavigationAccess,
  importNavigationRootOf,
  type ImportNavigationSourceFile
} from '../import-navigation/open-file-import-navigation-access'

type MonacoNamespace = typeof Monaco

type ImportTarget = {
  filePath: string
  relativePath: string
  worktreeId: string
  runtimeEnvironmentId: string | null
}

// Monaco only underlines and previews a definition whose model exists, so targets get a read-only twin.
const IMPORT_TARGET_SCHEME = 'orca-import-target'
const MAX_IMPORT_TARGET_MODELS = 8
const PREVIEW_LINES = 8

const sourceEditors = new Map<Monaco.editor.ICodeEditor, () => string>()
const importTargets = new Map<string, ImportTarget>()

/** Lets definition requests on this editor's model resolve imports through its tab's host. */
export function registerImportNavigationEditor(
  editorInstance: Monaco.editor.ICodeEditor,
  getFileId: () => string
): () => void {
  sourceEditors.set(editorInstance, getFileId)
  return () => {
    if (sourceEditors.get(editorInstance) === getFileId) {
      sourceEditors.delete(editorInstance)
    }
  }
}

function sourceFileOf(model: Monaco.editor.ITextModel): ImportNavigationSourceFile | null {
  for (const [editorInstance, getFileId] of sourceEditors) {
    if (editorInstance.getModel() !== model) {
      continue
    }
    const fileId = getFileId()
    const file = useAppStore.getState().openFiles.find((candidate) => candidate.id === fileId)
    if (file && file.mode === 'edit') {
      return file
    }
  }
  return null
}

function importTargetModel(
  monaco: MonacoNamespace,
  target: ImportTarget,
  content: string
): Monaco.editor.ITextModel {
  const uri = monaco.Uri.from({
    scheme: IMPORT_TARGET_SCHEME,
    // Why: the same path on two hosts must not share a preview.
    authority: encodeURIComponent(`${target.worktreeId}|${target.runtimeEnvironmentId ?? ''}`),
    path: monaco.Uri.file(target.filePath).path
  })
  const key = uri.toString()
  importTargets.delete(key)
  importTargets.set(key, target)
  // Why: plaintext keeps previews out of the TypeScript worker's program and idle accounting.
  const model = monaco.editor.getModel(uri) ?? monaco.editor.createModel(content, 'plaintext', uri)
  if (model.getValue() !== content) {
    model.setValue(content)
  }
  for (const oldest of [...importTargets.keys()].slice(
    0,
    Math.max(0, importTargets.size - MAX_IMPORT_TARGET_MODELS)
  )) {
    importTargets.delete(oldest)
    monaco.editor.getModel(monaco.Uri.parse(oldest))?.dispose()
  }
  return model
}

type ImportRequestCandidate = {
  request: ImportNavigationRequest
  /** Model paths the built-in answer named; the resolved import must be one of them. */
  confirmPaths: string[] | null
}

function modelPath(monaco: MonacoNamespace, filePath: string): string {
  // Why: reparsing folds drive letters the way editor model URIs do.
  return monaco.Uri.parse(monaco.Uri.file(filePath).toString()).path
}

function importRequestCandidate(
  model: Monaco.editor.ITextModel,
  position: Monaco.Position,
  definitions: readonly Monaco.languages.Location[],
  statements: ReturnType<typeof scanImportStatements>
): ImportRequestCandidate | null {
  const modelUri = model.uri.toString()
  const cursor = model.getOffsetAt(position)
  const sameFileOffsets = definitions
    .filter((definition) => definition.uri.toString() === modelUri)
    .map((definition) =>
      model.getOffsetAt({
        lineNumber: definition.range.startLineNumber,
        column: definition.range.startColumn
      })
    )
  const direct = findImportNavigationRequest(statements, cursor, sameFileOffsets)
  if (direct) {
    return { request: direct, confirmPaths: null }
  }
  const foreignPaths = definitions
    .filter((definition) => definition.uri.toString() !== modelUri)
    .map((definition) => definition.uri.path)
  const word = model.getWordAtPosition(position)?.word
  if (!word || foreignPaths.length === 0) {
    return null
  }
  // Why: an open model can satisfy the import itself, but a same-named member or library
  // definition must keep the built-in answer, so the resolved file is confirmed later.
  const bindingOffsets = statements.flatMap((statement) =>
    statement.bindings.filter((binding) => binding.local === word).map((binding) => binding.offset)
  )
  const request = findImportNavigationRequest(statements, cursor, bindingOffsets)
  return request ? { request, confirmPaths: foreignPaths } : null
}

async function importDefinition(
  monaco: MonacoNamespace,
  model: Monaco.editor.ITextModel,
  position: Monaco.Position,
  definitions: readonly Monaco.languages.Location[],
  token: Monaco.CancellationToken
): Promise<Monaco.languages.LocationLink | null> {
  const file = sourceFileOf(model)
  const rootPath = file ? importNavigationRootOf(file) : null
  if (!file || !rootPath) {
    return null
  }
  const candidate = importRequestCandidate(
    model,
    position,
    definitions,
    scanImportStatements(model.getValue())
  )
  const state = useAppStore.getState()
  const access = candidate ? createOpenFileImportNavigationAccess(state, file) : null
  if (!candidate || !access) {
    return null
  }
  const resolved = await resolveImportNavigationTarget(access, {
    ...candidate.request,
    fromFilePath: file.filePath,
    rootPath
  })
  const relativePath = resolved ? getRelativePathInsideRoot(resolved.filePath, rootPath) : null
  if (
    !resolved ||
    relativePath === null ||
    (candidate.confirmPaths &&
      !candidate.confirmPaths.includes(modelPath(monaco, resolved.filePath))) ||
    token.isCancellationRequested ||
    model.isDisposed()
  ) {
    return null
  }
  const owner = getRuntimeTargetForFileOwner(state, file.worktreeId, file.runtimeEnvironmentId)
  const targetModel = importTargetModel(
    monaco,
    {
      filePath: resolved.filePath,
      relativePath,
      worktreeId: file.worktreeId,
      runtimeEnvironmentId: owner?.kind === 'environment' ? owner.environmentId : null
    },
    resolved.content
  )
  const start = targetModel.getPositionAt(resolved.offset)
  const word = targetModel.getWordAtPosition(start)
  return {
    uri: targetModel.uri,
    // Why: eight or more lines make Monaco preview the declaration's indented block, not one name.
    range: {
      startLineNumber: start.lineNumber,
      startColumn: 1,
      endLineNumber: Math.min(targetModel.getLineCount(), start.lineNumber + PREVIEW_LINES),
      endColumn: 1
    },
    targetSelectionRange: {
      startLineNumber: start.lineNumber,
      startColumn: start.column,
      endLineNumber: start.lineNumber,
      endColumn: word && resolved.offset > 0 ? word.endColumn : start.column
    }
  }
}

function openImportTarget(target: ImportTarget, line: number, column: number): void {
  const store = useAppStore.getState()
  const fileId = store.openFile(
    {
      filePath: target.filePath,
      relativePath: target.relativePath,
      worktreeId: target.worktreeId,
      runtimeEnvironmentId: target.runtimeEnvironmentId,
      language: detectLanguage(target.filePath),
      mode: 'edit'
    },
    { suppressActiveRuntimeFallback: target.runtimeEnvironmentId === null }
  )
  if (detectLanguage(target.filePath) === 'markdown') {
    store.setMarkdownViewMode(fileId, 'source')
  }
  scheduleEditorLineReveal(useAppStore.getState, target.filePath, line, column, fileId)
}

function revealPosition(selectionOrPosition: Monaco.IRange | Monaco.IPosition | undefined): {
  line: number
  column: number
} {
  if (!selectionOrPosition) {
    return { line: 1, column: 1 }
  }
  return 'startLineNumber' in selectionOrPosition
    ? { line: selectionOrPosition.startLineNumber, column: selectionOrPosition.startColumn }
    : { line: selectionOrPosition.lineNumber, column: selectionOrPosition.column }
}

/**
 * Follows TS/JS imports on Go to Definition (Cmd/Ctrl+Click, F12): the sandboxed worker only knows
 * open files, so it answers an imported name with its own import line.
 */
export function installMonacoImportDefinitions(monaco: MonacoNamespace): void {
  const languages = [
    {
      id: 'typescript',
      defaults: monaco.typescript.typescriptDefaults,
      getWorker: monaco.typescript.getTypeScriptWorker
    },
    {
      id: 'javascript',
      defaults: monaco.typescript.javascriptDefaults,
      getWorker: monaco.typescript.getJavaScriptWorker
    }
  ]
  for (const { id, defaults, getWorker } of languages) {
    const worker = (...uris: Monaco.Uri[]) => getWorker().then((client) => client(...uris))
    const builtIn = new DefinitionAdapter(new LibFiles(worker), worker)
    // Why: wrapping, not adding, keeps one answer; two providers would turn every click into a peek list.
    defaults.setModeConfiguration({ ...defaults.modeConfiguration, definitions: false })
    monaco.languages.registerDefinitionProvider(id, {
      async provideDefinition(model, position, token) {
        const definitions = (await builtIn.provideDefinition(model, position, token)) ?? []
        if (token.isCancellationRequested || model.isDisposed()) {
          return definitions
        }
        const imported = await importDefinition(monaco, model, position, definitions, token).catch(
          () => null
        )
        return imported ? [imported] : definitions
      }
    })
  }
  monaco.editor.registerEditorOpener({
    openCodeEditor(_source, resource, selectionOrPosition) {
      const target = importTargets.get(resource.toString())
      if (!target) {
        return false
      }
      const { line, column } = revealPosition(selectionOrPosition)
      openImportTarget(target, line, column)
      return true
    }
  })
}
