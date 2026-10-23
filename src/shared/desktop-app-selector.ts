// How a computer-use `--app` selector names an app, with the same rules as resolveApp in the
// native helper, so main (blocking) and the renderer (indicator) never disagree on the target.

export type DesktopAppSelector = { kind: 'pid'; pid: number } | { kind: 'name'; name: string }

// Why: String.trim() misses U+0085, which Swift's `.whitespacesAndNewlines` strips, so a selector
// like "\u0085pid:5" would otherwise read as an unknown app here and as pid 5 in the helper.
const NATIVE_WHITESPACE_EDGES = /^[\p{Z}\t-\r\u0085]+|[\p{Z}\t-\r\u0085]+$/gu

export function parseDesktopAppSelector(selector: string | null): DesktopAppSelector | null {
  if (selector === null) {
    return null
  }
  const trimmed = selector.replace(NATIVE_WHITESPACE_EDGES, '')
  if (!trimmed) {
    return null
  }
  const pid = parsePid(trimmed)
  return pid !== null ? { kind: 'pid', pid } : { kind: 'name', name: trimmed }
}

/** Whether a name selector names this app by its display name or bundle id. */
export function selectorNamesApp(
  name: string,
  app: { appName: string | null | undefined; bundleId: string | null | undefined }
): boolean {
  return sameName(app.appName, name) || sameName(app.bundleId, name)
}

// Same grammar as parsePid in the helper: lowercase prefix, then an Int32 (optional sign) above 0.
function parsePid(selector: string): number | null {
  const match = /^pid:([+-]?\d+)$/.exec(selector)
  const pid = match ? Number(match[1]) : Number.NaN
  return Number.isInteger(pid) && pid > 0 && pid <= 2_147_483_647 ? pid : null
}

// Case-insensitive, accent-sensitive, like `caseInsensitiveCompare` in the helper. Fixed 'und'
// locale so the match never depends on the user's system language.
function sameName(name: string | null | undefined, selector: string): boolean {
  return name != null && name.localeCompare(selector, 'und', { sensitivity: 'accent' }) === 0
}
