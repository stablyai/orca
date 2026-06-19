import type { editor } from 'monaco-editor'

type DiffViewerModelPathInput = {
  modelKey: string
  originalModelKey?: string
  modifiedModelKey?: string
  generationSuffix: string
}

type DiffViewerModelPathPrefixes = {
  originalModelPathPrefix: string
  modifiedModelPathPrefix: string
}

type DisposableMonacoModel = Pick<editor.ITextModel, 'dispose' | 'isAttachedToEditor'> & {
  uri: { toString(skipEncoding?: boolean): string }
}

type MonacoModelRegistry = {
  Uri: {
    parse(value: string): unknown
  }
  editor: {
    getModel(uri: unknown): DisposableMonacoModel | null
    getModels(): DisposableMonacoModel[]
  }
}

function encodeDiffViewerModelKey(modelKey: string): string {
  return encodeURIComponent(modelKey).replace(/~/g, '~7E').replace(/%/g, '~')
}

export function getDiffViewerMonacoModelPathPrefixes(
  modelKey: string
): DiffViewerModelPathPrefixes {
  const encodedOwnerKey = encodeDiffViewerModelKey(modelKey)
  return {
    originalModelPathPrefix: `diff:original:${encodedOwnerKey}`,
    modifiedModelPathPrefix: `diff:modified:${encodedOwnerKey}`
  }
}

export function getDiffViewerMonacoModelPaths({
  modelKey,
  originalModelKey,
  modifiedModelKey,
  generationSuffix
}: DiffViewerModelPathInput): {
  originalModelPath: string
  modifiedModelPath: string
} {
  const prefixes = getDiffViewerMonacoModelPathPrefixes(modelKey)
  const resolvedOriginalModelKey = encodeDiffViewerModelKey(originalModelKey ?? modelKey)
  const resolvedModifiedModelKey = encodeDiffViewerModelKey(modifiedModelKey ?? modelKey)

  return {
    originalModelPath: `${prefixes.originalModelPathPrefix}:${resolvedOriginalModelKey}${generationSuffix}`,
    modifiedModelPath: `${prefixes.modifiedModelPathPrefix}:${resolvedModifiedModelKey}${generationSuffix}`
  }
}

export function disposeUnattachedDiffViewerMonacoModels(
  monacoRegistry: MonacoModelRegistry,
  modelPaths: { originalModelPath: string; modifiedModelPath: string }
): void {
  disposeUnattachedMonacoModelPaths(monacoRegistry, [
    modelPaths.originalModelPath,
    modelPaths.modifiedModelPath
  ])
}

export function disposeUnattachedMonacoModelPaths(
  monacoRegistry: MonacoModelRegistry,
  modelPaths: readonly string[]
): void {
  for (const modelPath of modelPaths) {
    const model = monacoRegistry.editor.getModel(monacoRegistry.Uri.parse(modelPath))
    disposeUnattachedMonacoModel(model)
  }
}

export function disposeUnattachedMonacoModelsByPathPrefix(
  monacoRegistry: MonacoModelRegistry,
  modelPathPrefix: string
): void {
  for (const model of monacoRegistry.editor.getModels()) {
    const uriString = model.uri.toString(true)
    const encodedUriString = model.uri.toString()

    if (
      uriString === modelPathPrefix ||
      uriString.startsWith(`${modelPathPrefix}:`) ||
      encodedUriString === modelPathPrefix ||
      encodedUriString.startsWith(`${modelPathPrefix}:`)
    ) {
      disposeUnattachedMonacoModel(model)
    }
  }
}

function disposeUnattachedMonacoModel(model: DisposableMonacoModel | null): void {
  if (!model || model.isAttachedToEditor()) {
    return
  }

  model.dispose()
}
