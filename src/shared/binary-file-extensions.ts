import { IMAGE_FILE_EXTENSIONS } from './image-file-extensions'

// SVG is an image format that editors open as source text, so it stays out of
// the binary set even though it lives in IMAGE_FILE_EXTENSIONS.
const TEXT_IMAGE_EXTENSIONS = new Set(['.svg'])

// Data files the OS hands to a viewer app; a plain link click may open them there.
const OS_VIEWER_BINARY_EXTENSIONS = [
  // Archives
  '.7z',
  '.bz2',
  '.gz',
  '.rar',
  '.tar',
  '.tgz',
  '.xz',
  '.zip',
  '.zst',
  // Audio and video
  '.aac',
  '.avi',
  '.flac',
  '.m4a',
  '.mkv',
  '.mov',
  '.mp3',
  '.mp4',
  '.ogg',
  '.wav',
  '.webm',
  // Documents
  '.doc',
  '.docx',
  '.pdf',
  '.ppt',
  '.pptx',
  '.xls',
  '.xlsx',
  // Fonts
  '.eot',
  '.otf',
  '.ttc',
  '.ttf',
  '.woff',
  '.woff2'
]

// Why: never routed to the OS app by a plain click — for some the OS default runs code
// (a .exe executes, a .jar launches Java).
const COMPILED_AND_DATASTORE_EXTENSIONS = [
  '.a',
  '.bin',
  '.class',
  '.dll',
  '.dylib',
  '.exe',
  '.idx',
  '.jar',
  '.lockb',
  '.node',
  '.o',
  '.pack',
  '.pyc',
  '.pyd',
  '.so',
  '.sqlite',
  '.sqlite3',
  '.war',
  '.wasm'
]

export const BINARY_FILE_EXTENSIONS: readonly string[] = Object.freeze([
  ...IMAGE_FILE_EXTENSIONS.filter((extension) => !TEXT_IMAGE_EXTENSIONS.has(extension)),
  ...OS_VIEWER_BINARY_EXTENSIONS,
  ...COMPILED_AND_DATASTORE_EXTENSIONS
])

const BINARY_FILE_EXTENSION_SET = new Set(BINARY_FILE_EXTENSIONS)

// Why: PDFs open in the editor's own viewer.
const OS_VIEWER_ONLY_EXTENSION_SET = new Set(
  OS_VIEWER_BINARY_EXTENSIONS.filter((extension) => extension !== '.pdf')
)

function lowerFileExtension(filePath: string | undefined): string | null {
  if (filePath === undefined) {
    return null
  }
  const lowerPath = filePath.toLowerCase()
  const dotIndex = lowerPath.lastIndexOf('.')
  const separatorIndex = Math.max(lowerPath.lastIndexOf('/'), lowerPath.lastIndexOf('\\'))
  // A leading dot is a dotfile (.gitignore), not an extension.
  if (dotIndex <= separatorIndex + 1) {
    return null
  }
  return lowerPath.slice(dotIndex)
}

/**
 * Extension-only guess at "this file is not text". Content-based detection
 * lives in `isBinaryBuffer`; use this only where the bytes are unavailable.
 */
export function hasBinaryFileExtension(filePath: string | undefined): boolean {
  const extension = lowerFileExtension(filePath)
  return extension !== null && BINARY_FILE_EXTENSION_SET.has(extension)
}

/**
 * A binary the editor has no viewer for and the OS opens in a viewer app (audio, video,
 * archives, Office documents, fonts). Executables and other loadable code are excluded.
 */
export function hasOsViewerOnlyFileExtension(filePath: string | undefined): boolean {
  const extension = lowerFileExtension(filePath)
  return extension !== null && OS_VIEWER_ONLY_EXTENSION_SET.has(extension)
}
