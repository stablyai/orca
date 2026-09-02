import { IMAGE_FILE_EXTENSIONS } from './image-file-extensions'

// SVG is an image format that editors open as source text, so it stays out of
// the binary set even though it lives in IMAGE_FILE_EXTENSIONS.
const TEXT_IMAGE_EXTENSIONS = new Set(['.svg'])

const NON_IMAGE_BINARY_EXTENSIONS = [
  // Archives
  '.7z',
  '.bz2',
  '.gz',
  '.jar',
  '.rar',
  '.tar',
  '.tgz',
  '.war',
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
  '.woff2',
  // Compiled artifacts and datastores
  '.a',
  '.bin',
  '.class',
  '.dll',
  '.dylib',
  '.exe',
  '.idx',
  '.lockb',
  '.node',
  '.o',
  '.pack',
  '.pyc',
  '.pyd',
  '.so',
  '.sqlite',
  '.sqlite3',
  '.wasm'
]

export const BINARY_FILE_EXTENSIONS: readonly string[] = Object.freeze([
  ...IMAGE_FILE_EXTENSIONS.filter((extension) => !TEXT_IMAGE_EXTENSIONS.has(extension)),
  ...NON_IMAGE_BINARY_EXTENSIONS
])

const BINARY_FILE_EXTENSION_SET = new Set(BINARY_FILE_EXTENSIONS)

/**
 * Extension-only guess at "this file is not text". Content-based detection
 * lives in `isBinaryBuffer`; use this only where the bytes are unavailable.
 */
export function hasBinaryFileExtension(filePath: string | undefined): boolean {
  if (filePath === undefined) {
    return false
  }
  const lowerPath = filePath.toLowerCase()
  const dotIndex = lowerPath.lastIndexOf('.')
  const separatorIndex = Math.max(lowerPath.lastIndexOf('/'), lowerPath.lastIndexOf('\\'))
  // A leading dot is a dotfile (.gitignore), not an extension.
  if (dotIndex <= separatorIndex + 1) {
    return false
  }
  return BINARY_FILE_EXTENSION_SET.has(lowerPath.slice(dotIndex))
}
