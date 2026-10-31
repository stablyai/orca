import { File, FileCog, FileLock, FileTerminal, type LucideIcon } from 'lucide-react'
import { COMPOUND_EXTENSIONS, FILE_ICON_BY_EXTENSION } from './file-type-icon-extension-table'
import { FILE_ICON_BY_NAME } from './file-type-icon-name-table'
import type { ActivePluginIconTheme } from '../store/plugin-icon-themes'

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

function ownIcon(table: Record<string, LucideIcon>, key: string): LucideIcon | undefined {
  return Object.hasOwn(table, key) ? table[key] : undefined
}

export function getFileTypeIcon(filePath: string | undefined | null): LucideIcon {
  const filename = getFilename(filePath)
  if (!filename) {
    return File
  }
  const lowerName = filename.toLowerCase()
  const exactMatch = ownIcon(FILE_ICON_BY_NAME, lowerName)
  if (exactMatch) {
    return exactMatch
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
  return ownIcon(FILE_ICON_BY_EXTENSION, getExtension(filename)) ?? File
}

function ownIconIndex(entries: Partial<Record<string, number>>, key: string): number | null {
  if (!Object.hasOwn(entries, key)) {
    return null
  }
  const index = entries[key]
  return Number.isInteger(index) && index !== undefined && index >= 0 ? index : null
}

// Longest dotted suffix first, so a theme's `d.ts` wins over `ts` and `gz` still matches `a.tar.gz`.
function ownExtensionIconIndex(
  entries: Partial<Record<string, number>>,
  filename: string
): number | null {
  const parts = filename.split('.')
  for (let start = 1; start < parts.length; start += 1) {
    const index = ownIconIndex(entries, parts.slice(start).join('.'))
    if (index !== null) {
      return index
    }
  }
  return null
}

/** The active plugin icon theme's icon index for a path: exact name, then extension, then
 *  its file icon. */
export function getPluginFileTypeIconIndex(
  theme: ActivePluginIconTheme | null,
  filePath: string | undefined | null
): number | null {
  const filename = getFilename(filePath).toLowerCase()
  if (!theme || !filename) {
    return null
  }
  return (
    ownIconIndex(theme.fileNames, filename) ??
    ownExtensionIconIndex(theme.fileExtensions, filename) ??
    ownIconIndex(theme.icons, 'file')
  )
}
