import type React from 'react'
import { DEFAULT_FILE_ICON_THEME } from '../../../../shared/file-icon-theme'
import { useAppStore } from '@/store'
import { getFileTypeIcon } from '@/lib/file-type-icons'
import { MaterialFileIcon } from '@/lib/material-file-icons'

type ThemedFileIconProps = {
  filePath: string | undefined | null
  className: string
  classicClassName?: string
  classicStyle?: React.CSSProperties
  isMuted?: boolean
}

/** Centralize theme selection so every file surface retains the same classic fallback behavior. */
export function ThemedFileIcon({
  className,
  classicClassName,
  classicStyle,
  filePath,
  isMuted = false
}: ThemedFileIconProps): React.JSX.Element {
  const fileIconTheme =
    useAppStore((state) => state.settings?.fileIconTheme) ?? DEFAULT_FILE_ICON_THEME
  const ClassicIcon = getFileTypeIcon(filePath)
  const classicIcon = <ClassicIcon className={classicClassName ?? className} style={classicStyle} />

  if (fileIconTheme !== 'material') {
    return classicIcon
  }

  return (
    <MaterialFileIcon
      className={className}
      fallbackIcon={classicIcon}
      filePath={filePath}
      isMuted={isMuted}
    />
  )
}
