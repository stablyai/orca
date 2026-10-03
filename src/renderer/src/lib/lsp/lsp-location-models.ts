// src/renderer/src/lib/lsp/lsp-location-models.ts
import { toEditorModelUri } from '@/components/editor/editor-model-uri'
import { toMonacoRange, type LspLocation, type MonacoRangeLike } from './lsp-conversions'

export const LSP_PEEK_SCHEME = 'orca-lsp-peek'
export const MAX_LOCATION_FILES = 100
const MAX_PEEK_MODELS = 50

type UriLike = { scheme: string; path: string; fsPath: string; toString(): string }
type PeekModel = {
  isAttachedToEditor(): boolean
  dispose(): void
  isDisposed?(): boolean
  getValue(): string
  setValue(value: string): void
}
/** Generic over the Uri class so real Monaco (its Uri) and tests (the esm URI) both type-check. */
export type LocationModelMonaco<U extends UriLike> = {
  Uri: { parse(value: string): U; from(components: { scheme: string; path: string }): U }
  editor: {
    getModel(uri: U): PeekModel | null
    createModel(value: string, language: string | undefined, uri: U): PeekModel
  }
}
type ReadFile = (filePath: string) => Promise<{ content: string; isBinary: boolean }>

const peekModels: { key: string; model: PeekModel }[] = []

// Why: models of the result being returned must survive until Monaco attaches them, even past the cap.
function prunePeekModels(keep: Set<string>): void {
  for (let i = peekModels.length - 1; i >= 0; i--) {
    if (peekModels[i].model.isDisposed?.()) {
      peekModels.splice(i, 1)
    }
  }
  for (let i = 0; i < peekModels.length && peekModels.length > MAX_PEEK_MODELS;) {
    const { key, model } = peekModels[i]
    if (keep.has(key) || model.isAttachedToEditor()) {
      i++
      continue
    }
    peekModels.splice(i, 1)
    model.dispose()
  }
}

async function modelUriFor<U extends UriLike>(
  monaco: LocationModelMonaco<U>,
  fsPath: string,
  readFile: ReadFile
): Promise<U | null> {
  // Why: toEditorModelUri canonicalizes drive-letter spelling so server URIs land on Orca's own models.
  const fileUri = monaco.Uri.parse(toEditorModelUri(fsPath))
  if (monaco.editor.getModel(fileUri)) {
    return fileUri
  }
  // Why: peek needs a model per location; a separate scheme keeps Orca's file-model ownership untouched.
  const peekUri = monaco.Uri.from({ scheme: LSP_PEEK_SCHEME, path: fileUri.path })
  const existing = monaco.editor.getModel(peekUri)
  if (existing?.isAttachedToEditor()) {
    return peekUri
  }
  const file = await readFile(fsPath).catch(() => null)
  const current = monaco.editor.getModel(peekUri)
  if (current) {
    // Why: a detached peek model may be stale; an attached one is left alone mid-peek.
    if (current.isAttachedToEditor()) {
      return peekUri
    }
    if (!file || file.isBinary) {
      current.dispose()
      return null
    }
    if (current.getValue() !== file.content) {
      current.setValue(file.content)
    }
    return peekUri
  }
  if (!file || file.isBinary) {
    return null
  }
  peekModels.push({
    key: peekUri.toString(),
    model: monaco.editor.createModel(file.content, undefined, peekUri)
  })
  return peekUri
}

export async function resolveLocationModels<U extends UriLike>(
  monaco: LocationModelMonaco<U>,
  locations: LspLocation[],
  readFile: ReadFile
): Promise<{ uri: U; range: MonacoRangeLike }[]> {
  const byPath = new Map<string, Promise<U | null>>()
  const pending: { fsPath: string; location: LspLocation }[] = []
  // Why: start every read before awaiting any, so N files cost one round of IPC latency.
  for (const location of locations) {
    const fsPath = monaco.Uri.parse(location.uri).fsPath
    if (!byPath.has(fsPath)) {
      if (byPath.size >= MAX_LOCATION_FILES) {
        continue
      }
      byPath.set(fsPath, modelUriFor(monaco, fsPath, readFile))
    }
    pending.push({ fsPath, location })
  }
  const resolved: { uri: U; range: MonacoRangeLike }[] = []
  for (const { fsPath, location } of pending) {
    const uri = await byPath.get(fsPath)
    if (uri) {
      resolved.push({ uri, range: toMonacoRange(location.range) })
    }
  }
  prunePeekModels(new Set(resolved.map(({ uri }) => uri.toString())))
  return resolved
}
