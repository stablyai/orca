import type { IconNode, IconTheme, IconThemeFileRule } from './types'

const COMPOUND_EXTENSIONS = ['tar.bz2', 'tar.gz', 'tar.xz']

function getFilename(filePath: string): string {
  const lastSlash = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'))
  return lastSlash >= 0 ? filePath.slice(lastSlash + 1) : filePath
}

function getExtension(lowerFilename: string): string {
  const compound = COMPOUND_EXTENSIONS.find((ext) => lowerFilename.endsWith(`.${ext}`))
  if (compound) {
    return compound
  }
  const lastDot = lowerFilename.lastIndexOf('.')
  if (lastDot <= 0 || lastDot === lowerFilename.length - 1) {
    return ''
  }
  return lowerFilename.slice(lastDot + 1)
}

function matchFileRule(rule: IconThemeFileRule, lowerFilename: string, extension: string): boolean {
  if (rule.filename && rule.filename === lowerFilename) {
    return true
  }
  if (rule.pattern && rule.pattern.test(lowerFilename)) {
    return true
  }
  if (rule.extension && rule.extension === extension) {
    return true
  }
  return false
}

/**
 * Pure icon resolver. Evaluates the theme's rule lists against the given
 * `filePath` and returns the icon component to render. Order:
 *
 *   1. Folder branch: exact lower-case folder-name lookup → fallback.
 *   2. File branch: `resolveFileIcon` escape hatch → filename → pattern →
 *      extension → fallback.
 *
 * Each rule may only contribute its own match shape (filename / pattern /
 * extension) — earlier rules win on ties. Re-using existing match shapes from
 * `file-type-icons.ts` keeps behavior parity for the `default` theme.
 */
export function resolveIcon(
  theme: IconTheme,
  filePath: string,
  isDirectory: boolean,
  isOpen: boolean
): IconNode {
  const filename = getFilename(filePath)
  const lower = filename.toLowerCase()

  if (isDirectory) {
    const folderRule = theme.folderRules.find((r) => r.name === lower)
    if (folderRule) {
      return isOpen ? (folderRule.open ?? folderRule.closed) : folderRule.closed
    }
    return isOpen ? theme.defaultFolder.open : theme.defaultFolder.closed
  }

  if (theme.resolveFileIcon) {
    const fromHook = theme.resolveFileIcon(filePath)
    if (fromHook) {
      return fromHook
    }
  }

  const extension = getExtension(lower)

  for (const rule of theme.fileRules) {
    if (matchFileRule(rule, lower, extension)) {
      return rule.icon
    }
  }

  return theme.defaultFileIcon
}
