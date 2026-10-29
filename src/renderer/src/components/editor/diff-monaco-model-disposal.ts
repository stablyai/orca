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

export type DisposableMonacoModel = Pick<editor.ITextModel, 'dispose' | 'isAttachedToEditor'> & {
  uri: { toString(skipEncoding?: boolean): string }
}

export type MonacoModelRegistry = {
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

/** Sweep owned prefixes in one registry pass; per-prefix scans multiply retained-model enumeration and URI allocations. */
export function disposeUnattachedMonacoModelsByPathPrefixes(
  monacoRegistry: MonacoModelRegistry,
  modelPathPrefixes: readonly string[],
  onAttachedModel?: (model: DisposableMonacoModel, prefix: string) => void,
  isStillOwned: (prefix: string) => boolean = () => true
): void {
  if (modelPathPrefixes.length === 0) {
    return
  }

  const ownedPrefixes = new Set(modelPathPrefixes)
  let shortestPrefixLength = Number.POSITIVE_INFINITY
  let longestPrefixLength = 0
  for (const prefix of ownedPrefixes) {
    shortestPrefixLength = Math.min(shortestPrefixLength, prefix.length)
    longestPrefixLength = Math.max(longestPrefixLength, prefix.length)
  }

  const bounds = { shortestPrefixLength, longestPrefixLength }
  for (const model of monacoRegistry.editor.getModels()) {
    // Uri.parse can expose decoded or encoded tab IDs; match both renderings.
    const prefix =
      findOwnedPathPrefix(model.uri.toString(true), ownedPrefixes, bounds) ??
      findOwnedPathPrefix(model.uri.toString(), ownedPrefixes, bounds)
    if (prefix !== undefined && isStillOwned(prefix)) {
      if (model.isAttachedToEditor()) {
        onAttachedModel?.(model, prefix)
      } else {
        model.dispose()
      }
    }
  }
}

/** Probe URI colon boundaries for exact/prefix ownership, making work depend on segments rather than owned-prefix count. */
function findOwnedPathPrefix(
  uriString: string,
  ownedPrefixes: ReadonlySet<string>,
  bounds: { shortestPrefixLength: number; longestPrefixLength: number }
): string | undefined {
  if (ownedPrefixes.has(uriString)) {
    return uriString
  }

  for (
    let boundary = uriString.indexOf(':');
    boundary !== -1 && boundary <= bounds.longestPrefixLength;
    boundary = uriString.indexOf(':', boundary + 1)
  ) {
    if (
      boundary >= bounds.shortestPrefixLength &&
      ownedPrefixes.has(uriString.slice(0, boundary))
    ) {
      return uriString.slice(0, boundary)
    }
  }

  return undefined
}

function disposeUnattachedMonacoModel(model: DisposableMonacoModel | null): void {
  if (!model || model.isAttachedToEditor()) {
    return
  }

  model.dispose()
}
