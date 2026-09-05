import { recordRendererCrashBreadcrumb } from '@/lib/crash-breadcrumb-recorder'

export type MonacoUriNamespace = {
  parse(value: string): unknown
  file(path: string): { toString(): string }
}

const SCHEME_PREFIX_CHAR_CLASSES: readonly (readonly [string, RegExp])[] = [
  ['alpha', /[a-z]/i],
  ['digit', /\d/],
  ['backslash', /\\/],
  ['slash', /\//],
  ['schemeSafePunct', /[.+-]/],
  ['space', / /]
]

/** Character classes before the first `:`, so a crumb names the shape without carrying the path. */
function schemePrefixCharset(prefix: string): string {
  const classes = new Set(
    [...prefix].map(
      (char) => SCHEME_PREFIX_CHAR_CLASSES.find(([, pattern]) => pattern.test(char))?.[0] ?? 'other'
    )
  )
  return [...classes].sort().join('|')
}

/**
 * Shape-only crumb for a path Monaco's URI parser rejects.
 *
 * Why at all: the guards below turn the field crash into a silent rewrite, and the crash was the
 * only signal that ever surfaced this input class — its producer is still unidentified. Shape
 * fields only; the crash pipeline redacts raw paths anyway.
 */
export function recordUnparseableModelPathShape(name: string, filePath: string): void {
  const path = String(filePath)
  const firstColon = path.indexOf(':')
  recordRendererCrashBreadcrumb(name, {
    length: path.length,
    colons: path.split(':').length - 1,
    hasBackslash: path.includes('\\'),
    schemePrefixLength: firstColon,
    schemePrefixCharset: schemePrefixCharset(firstColon === -1 ? '' : path.slice(0, firstColon))
  })
}

/**
 * The path an edit tab's Monaco model is keyed by, in a form `Uri.parse` always accepts.
 *
 * Why: Monaco reads everything before the first `:` as a URI scheme, so a drive-less backslash
 * path carrying a `:` — a WSL/UNC file whose name reached us from Linux-side tooling, which keeps
 * the literal colon Win32 enumeration hides behind U+F03A — throws `[UriError]: Scheme contains
 * illegal characters.` Paths that already parse are returned unchanged, so no model key or
 * view-state cache entry that works today moves.
 */
export function toMonacoEditModelPath(uri: MonacoUriNamespace, filePath: string): string {
  try {
    uri.parse(filePath)
    return filePath
  } catch {
    recordUnparseableModelPathShape('editor_model_path_uri_rejected', filePath)
    return uri.file(filePath).toString()
  }
}
