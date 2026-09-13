import type * as monacoTypes from 'monaco-editor'
import type { LspDocumentContext, LspLocation } from '../../../shared/lsp-types'
import { resolveLspNavigationPath } from './monaco-lsp-navigation'
import { detectLanguage } from './language-detect'

type Preview = { model: monacoTypes.editor.ITextModel; owner: LspDocumentContext }
const requests = new Map<string, object>()
const previews = new Map<string, Preview[]>()
const MAX_PREVIEW_FILES = 50
const MAX_PREVIEW_CHARACTERS = 5_000_000

export function clearLspNavigationModels(modelUri: string): void {
  requests.delete(modelUri)
  disposePreviews(modelUri)
}

function disposePreviews(modelUri: string): void {
  const owned = previews.get(modelUri)
  previews.delete(modelUri)
  for (const preview of owned ?? []) {
    preview.model.dispose()
  }
}

export function getLspNavigationModelContext(
  model: monacoTypes.editor.ITextModel
): LspDocumentContext | undefined {
  for (const owned of previews.values()) {
    const preview = owned.find((entry) => entry.model === model)
    if (preview) {
      return preview.owner
    }
  }
  return undefined
}

export async function prepareLspNavigationModels(
  monaco: typeof monacoTypes,
  context: LspDocumentContext & { modelUri: string },
  locations: LspLocation[],
  isOwnerCurrent: () => boolean,
  openModelForFile?: (filePath: string) => monacoTypes.editor.ITextModel | undefined
): Promise<monacoTypes.languages.Location[]> {
  const request = {}
  requests.set(context.modelUri, request)
  const isCurrent = (): boolean => isOwnerCurrent() && requests.get(context.modelUri) === request
  const targets = locations
    .map((location) => {
      const resource = monaco.Uri.parse(location.uri)
      const path = resolveLspNavigationPath(resource, context.worktreePath)
      return { location, resource, path }
    })
    .filter((target) => target.path)
  const external = new Map(
    targets
      .filter((target) => target.path?.filePath !== context.filePath)
      .map((target) => [target.path!.filePath, target])
  )
  if (external.size > MAX_PREVIEW_FILES) {
    throw new Error('LSP navigation spans more than 50 files; narrow the symbol search.')
  }
  const created: Preview[] = []
  const uris = new Map<string, monacoTypes.Uri>()
  let characters = 0
  try {
    for (const [filePath, target] of external) {
      if (!isCurrent()) {
        return []
      }
      const openModel = openModelForFile?.(filePath)
      const file = openModel
        ? { content: openModel.getValue(), isBinary: false }
        : await window.api.fs.readFile({ filePath, connectionId: context.connectionId })
      characters += file.content.length
      if (file.isBinary || characters > MAX_PREVIEW_CHARACTERS) {
        throw new Error('LSP navigation preview exceeds the text size limit.')
      }
      if (!isCurrent()) {
        return []
      }
      // Why: previews must not share models between SSH hosts or overwrite unsaved editor buffers.
      const uri = target.resource.with({
        query: `orca-lsp=${encodeURIComponent(context.documentId ?? context.modelUri)}&preview=${Math.random()}`
      })
      const model = monaco.editor.createModel(file.content, detectLanguage(filePath), uri)
      created.push({ model, owner: context })
      uris.set(filePath, uri)
    }
    if (!isCurrent()) {
      return []
    }
    disposePreviews(context.modelUri)
    previews.set(context.modelUri, created.splice(0))
    return targets.map(({ location, path }) => ({
      uri:
        path!.filePath === context.filePath
          ? monaco.Uri.parse(context.modelUri)
          : uris.get(path!.filePath)!,
      range: new monaco.Range(
        location.range.start.line + 1,
        location.range.start.character + 1,
        location.range.end.line + 1,
        location.range.end.character + 1
      )
    }))
  } finally {
    for (const preview of created) {
      preview.model.dispose()
    }
  }
}
