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

/**
 * Sweeps every owned prefix in a single scan of the global model registry.
 *
 * Why batched: `getModels()` returns every retained model in the app, so closing N diff tabs one
 * prefix at a time costs N full scans and 2xN `uri.toString()` allocations per model. Closing 100
 * tabs against 700 retained models is ~140k throwaway strings inside one synchronous effect.
 */
export function disposeUnattachedMonacoModelsByPathPrefixes(
  monacoRegistry: MonacoModelRegistry,
  modelPathPrefixes: readonly string[]
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
    // Why both forms: model URIs are built via `Uri.parse`, so a prefix can match the decoded or
    // the percent-encoded rendering depending on what characters the tab id carries.
    if (
      isOwnedByPathPrefix(model.uri.toString(true), ownedPrefixes, bounds) ||
      isOwnedByPathPrefix(model.uri.toString(), ownedPrefixes, bounds)
    ) {
      disposeUnattachedMonacoModel(model)
    }
  }
}

/**
 * Equivalent to `uri === prefix || uri.startsWith(`${prefix}:`)` for any prefix in the set, but
 * probes the URI's own `:` boundaries instead of testing every prefix — O(segments) not O(prefixes).
 */
function isOwnedByPathPrefix(
  uriString: string,
  ownedPrefixes: ReadonlySet<string>,
  bounds: { shortestPrefixLength: number; longestPrefixLength: number }
): boolean {
  if (ownedPrefixes.has(uriString)) {
    return true
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
      return true
    }
  }

  return false
}

function disposeUnattachedMonacoModel(model: DisposableMonacoModel | null): void {
  if (!model || model.isAttachedToEditor()) {
    return
  }

  model.dispose()
}
