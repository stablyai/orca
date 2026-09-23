import { IMAGE_FILE_EXTENSIONS } from './media-file-extensions'

export { IMAGE_FILE_MIME_TYPES, IMAGE_FILE_EXTENSIONS } from './media-file-extensions'

// Keep SVG out of binary extensions because editors open it as source text.
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

// Why: the editor renders these binaries in its image and PDF viewers; any other binary
// can only show "Binary file — cannot display".
const EDITOR_VIEWABLE_BINARY_EXTENSION_SET = new Set([...IMAGE_FILE_EXTENSIONS, '.pdf'])

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

/** Guess by extension only without bytes; use isBinaryBuffer for content-based detection. */
export function hasBinaryFileExtension(filePath: string | undefined): boolean {
  const extension = lowerFileExtension(filePath)
  return extension !== null && BINARY_FILE_EXTENSION_SET.has(extension)
}

/** A known binary the editor has no viewer for (audio, video, archives, Office documents, …). */
export function hasBinaryFileExtensionWithoutEditorViewer(filePath: string | undefined): boolean {
  const extension = lowerFileExtension(filePath)
  return (
    extension !== null &&
    BINARY_FILE_EXTENSION_SET.has(extension) &&
    !EDITOR_VIEWABLE_BINARY_EXTENSION_SET.has(extension)
  )
}
