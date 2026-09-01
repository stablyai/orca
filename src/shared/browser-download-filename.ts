const WINDOWS_RESERVED_FILENAME_CHARS = new Set(['<', '>', ':', '"', '|', '?', '*'])
const WINDOWS_RESERVED_FILENAME =
  /^(?:con|prn|aux|nul|clock\$|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/iu

export const MAX_BROWSER_DOWNLOAD_COLLISION_ATTEMPTS = 1_000

export function normalizeBrowserDownloadFilename(
  filename: string,
  platform: NodeJS.Platform
): string {
  // Normalize separators first so basename strips paths from any platform.
  const normalizedSeparators = filename.replace(/\\/g, '/')
  const rawBasename = normalizedSeparators.split('/').at(-1)?.trim() ?? ''
  const safeName = [...rawBasename]
    .map((char) => {
      if (char.charCodeAt(0) < 32 || WINDOWS_RESERVED_FILENAME_CHARS.has(char)) {
        return '_'
      }
      return char
    })
    .join('')
    .replace(/[. ]+$/g, '')
    .trim()
  if (!safeName || safeName === '.' || safeName === '..') {
    return 'download'
  }
  return platform === 'win32' && WINDOWS_RESERVED_FILENAME.test(safeName)
    ? `_${safeName}`
    : safeName
}

export function buildBrowserDownloadCollisionCandidate(filename: string, suffix: number): string {
  if (suffix === 0) {
    return filename
  }
  const dot = filename.lastIndexOf('.')
  const extension = dot > 0 ? filename.slice(dot) : ''
  const stem = extension ? filename.slice(0, -extension.length) : filename
  return `${stem} (${suffix})${extension}`
}
