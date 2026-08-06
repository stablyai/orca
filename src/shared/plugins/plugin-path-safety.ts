/** Windows normalizes these names even when the host doing validation does not. */
const WINDOWS_DEVICE_NAME_RE =
  /^(?:con|prn|aux|nul|clock\$|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])(?:\..*)?$/i

const WINDOWS_FORBIDDEN_CHAR_RE = /[<>:"|?*]/

export function pluginPathSegmentError(segment: string): string | null {
  if (segment.length === 0 || segment === '.' || segment === '..') {
    return 'empty and dot path segments are not allowed'
  }
  if (segment.endsWith('.') || segment.endsWith(' ')) {
    return 'path segments may not end with a dot or space'
  }
  if (
    WINDOWS_FORBIDDEN_CHAR_RE.test(segment) ||
    [...segment].some((character) => character.charCodeAt(0) <= 31)
  ) {
    return 'path segment contains a Windows-forbidden character or alternate-data-stream colon'
  }
  if (WINDOWS_DEVICE_NAME_RE.test(segment)) {
    return 'path segment is a Windows reserved device name'
  }
  return null
}

export function pluginRelativePathError(value: string): string | null {
  if (value.length === 0 || value.startsWith('/') || value.startsWith('\\')) {
    return 'must be a non-empty relative path'
  }
  const segments = value.split(/[\\/]/)
  for (const segment of segments) {
    const error = pluginPathSegmentError(segment)
    if (error) {
      return error
    }
  }
  return null
}

export function isSafePluginRelativePath(value: string): boolean {
  return pluginRelativePathError(value) === null
}
