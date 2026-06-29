export type LazyChunkErrorBreadcrumbData = {
  reloadKey: string
  errorName: string
  errorCategory: string
  messageClass: string
}

export function describeLazyChunkError(
  reloadKey: string,
  error: unknown
): LazyChunkErrorBreadcrumbData {
  const errorName = classifyErrorName(error)
  const message = error instanceof Error ? error.message : stringifyUnknown(error)
  const messageClass = classifyErrorMessage(message)
  return {
    reloadKey: sanitizeReloadKey(reloadKey),
    errorName,
    errorCategory: classifyErrorCategory(messageClass, errorName),
    messageClass
  }
}

export function isAppRestartEligibleLazyChunkError(data: LazyChunkErrorBreadcrumbData): boolean {
  return data.errorCategory === 'syntax' || data.errorCategory === 'fetch'
}

function classifyErrorName(error: unknown): string {
  if (!(error instanceof Error)) {
    return 'NonError'
  }
  switch (error.name) {
    case 'AggregateError':
    case 'ChunkLoadError':
    case 'DOMException':
    case 'EvalError':
    case 'Error':
    case 'RangeError':
    case 'ReferenceError':
    case 'SyntaxError':
    case 'TypeError':
    case 'URIError':
      return error.name
    default:
      return 'Error'
  }
}

function classifyErrorMessage(message: string): string {
  const normalized = message.toLowerCase()
  const looksLikeJsonParseFailure =
    normalized.includes('json') || normalized.includes('not valid json')
  // Why: recovery should catch broken emitted JS chunks without treating
  // ordinary data-parse failures as app-shell corruption.
  if (
    (!looksLikeJsonParseFailure &&
      (normalized.includes('unexpected token') ||
        normalized.includes('unexpected end of input'))) ||
    normalized.includes('illegal return') ||
    normalized.includes('import declarations may only appear') ||
    normalized.includes('missing ) after argument list')
  ) {
    return 'syntax'
  }
  // Why: browsers report dynamic import failures differently, but these all
  // indicate a missing/stale chunk that a guarded reload may repair.
  if (
    normalized.includes('failed to fetch dynamically imported module') ||
    normalized.includes('error loading dynamically imported module') ||
    normalized.includes('importing a module script failed') ||
    normalized.includes('failed to load module script') ||
    normalized.includes('loading chunk') ||
    normalized.includes('chunkloaderror') ||
    normalized.includes('networkerror')
  ) {
    return 'fetch'
  }
  return 'unknown'
}

function classifyErrorCategory(messageClass: string, errorName: string): string {
  if (messageClass === 'syntax') {
    return 'syntax'
  }
  // Why: webpack-style chunk failures can arrive as a name without a useful
  // message, so keep the name as a narrow fetch fallback.
  if (messageClass === 'fetch' || errorName === 'ChunkLoadError') {
    return 'fetch'
  }
  return 'unknown'
}

function sanitizeReloadKey(reloadKey: string): string {
  const trimmed = reloadKey.trim()
  return /^[a-z0-9._:-]{1,80}$/i.test(trimmed) ? trimmed : 'unknown'
}

function stringifyUnknown(value: unknown): string {
  try {
    return String(value)
  } catch {
    return ''
  }
}
