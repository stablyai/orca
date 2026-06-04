import type React from 'react'
import { Folder, FolderOpen, type LucideIcon } from 'lucide-react'
import {
  DEFAULT_FILE_ICON_THEME_ID,
  normalizeFileIconThemeId,
  type FileIconThemeId
} from '../../../shared/file-icon-theme'
import {
  ColorFolderIcon,
  ColorFolderOpenIcon,
  DefaultFileIcon,
  ORCA_COLOR_COMPOUND_EXTENSIONS,
  ORCA_COLOR_FILE_BY_EXTENSION,
  ORCA_COLOR_FILE_BY_NAME,
  ORCA_COLOR_FOLDER_BY_NAME,
  type FileThemeSvgIcon
} from './file-icon-theme-colored-glyphs'
import { cn } from './utils'
import { getFileTypeIcon } from './file-type-icons'

type ResolvedFileIcon = {
  Icon: LucideIcon | FileThemeSvgIcon
  themed: boolean
}

type ResolveFileIconThemeInput = {
  themeId: FileIconThemeId | null | undefined
  path: string
  isDirectory?: boolean
  isExpanded?: boolean
}

type ThemedFileIconProps = ResolveFileIconThemeInput & {
  className?: string
  lucideClassName?: string
  lucideStyle?: React.CSSProperties
}

function getThemeFilename(filePath: string): string {
  const lastSlash = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'))
  return lastSlash >= 0 ? filePath.slice(lastSlash + 1) : filePath
}

function getThemeExtension(filename: string): string {
  const lowerName = filename.toLowerCase()
  const compoundExtension = ORCA_COLOR_COMPOUND_EXTENSIONS.find((ext) =>
    lowerName.endsWith(`.${ext}`)
  )
  if (compoundExtension) {
    return compoundExtension
  }

  const lastDot = filename.lastIndexOf('.')
  if (lastDot <= 0 || lastDot === filename.length - 1) {
    return ''
  }

  return filename.slice(lastDot + 1).toLowerCase()
}

export function resolveFileIconTheme(input: ResolveFileIconThemeInput): ResolvedFileIcon {
  const themeId = normalizeFileIconThemeId(input.themeId)
  if (themeId === DEFAULT_FILE_ICON_THEME_ID) {
    return {
      Icon: input.isDirectory
        ? input.isExpanded
          ? FolderOpen
          : Folder
        : getFileTypeIcon(input.path),
      themed: false
    }
  }

  if (input.isDirectory) {
    const folderName = getThemeFilename(input.path).toLowerCase()
    const folderIcons = ORCA_COLOR_FOLDER_BY_NAME[folderName]
    return {
      Icon: folderIcons
        ? input.isExpanded
          ? folderIcons.open
          : folderIcons.closed
        : input.isExpanded
          ? ColorFolderOpenIcon
          : ColorFolderIcon,
      themed: true
    }
  }

  const filename = getThemeFilename(input.path)
  const lowerName = filename.toLowerCase()
  if (lowerName === '.env' || lowerName.startsWith('.env.')) {
    return { Icon: ORCA_COLOR_FILE_BY_EXTENSION['lock'] ?? DefaultFileIcon, themed: true }
  }
  if (lowerName === 'dockerfile' || lowerName.startsWith('dockerfile.')) {
    return { Icon: ORCA_COLOR_FILE_BY_NAME['dockerfile'] ?? DefaultFileIcon, themed: true }
  }
  if (lowerName === 'makefile' || lowerName.startsWith('makefile.')) {
    return { Icon: ORCA_COLOR_FILE_BY_NAME['makefile'] ?? DefaultFileIcon, themed: true }
  }

  return {
    Icon:
      ORCA_COLOR_FILE_BY_NAME[lowerName] ??
      ORCA_COLOR_FILE_BY_EXTENSION[getThemeExtension(filename)] ??
      DefaultFileIcon,
    themed: true
  }
}

export function ThemedFileIcon({
  className,
  lucideClassName,
  lucideStyle,
  ...input
}: ThemedFileIconProps): React.JSX.Element {
  const { Icon, themed } = resolveFileIconTheme(input)
  return (
    <Icon
      aria-hidden="true"
      className={cn(className, !themed && lucideClassName)}
      style={themed ? undefined : lucideStyle}
    />
  )
}
