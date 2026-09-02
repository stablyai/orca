import { File, FileCog, FileLock, FileTerminal, Smartphone, type LucideIcon } from 'lucide-react'
import { COMPOUND_EXTENSIONS, FILE_ICON_BY_EXTENSION } from './file-type-icon-extension-table'
import { FILE_ICON_BY_NAME } from './file-type-icon-name-table'

function getFilename(filePath: string | undefined | null): string {
  if (!filePath) {
    return ''
  }
  const lastSlash = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'))
  return lastSlash >= 0 ? filePath.slice(lastSlash + 1) : filePath
}

function getExtension(filename: string): string {
  const lowerName = filename.toLowerCase()
  const compoundExtension = COMPOUND_EXTENSIONS.find((ext) => lowerName.endsWith(`.${ext}`))
  if (compoundExtension) {
    return compoundExtension
  }

  const lastDot = filename.lastIndexOf('.')
  if (lastDot <= 0 || lastDot === filename.length - 1) {
    return ''
  }

  return filename.slice(lastDot + 1).toLowerCase()
}

export function getFileTypeIcon(filePath: string | undefined | null): LucideIcon {
  const filename = getFilename(filePath)
  if (!filename) {
    return File
  }
  const lowerName = filename.toLowerCase()
  const exactMatch = FILE_ICON_BY_NAME[lowerName]
  if (exactMatch) {
    return exactMatch
  }

  // Why: simulator tabs reuse EditorFileTab chrome with a synthetic label path.
  if (lowerName === 'mobile emulator' || lowerName === 'simulator') {
    return Smartphone
  }

  if (lowerName === '.env' || lowerName.startsWith('.env.')) {
    return FileLock
  }

  if (lowerName === 'dockerfile' || lowerName.startsWith('dockerfile.')) {
    return FileCog
  }

  if (lowerName === 'makefile' || lowerName.startsWith('makefile.')) {
    return FileTerminal
  }

  // Why: filename/extension matching keeps icons deterministic for SSH worktrees
  // where OS-native file associations are not available.
  return FILE_ICON_BY_EXTENSION[getExtension(filename)] ?? File
}
