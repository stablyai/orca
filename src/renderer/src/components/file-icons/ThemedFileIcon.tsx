import { getFileTypeIcon } from '@/lib/file-type-icons'
import {
  resolvePluginFileIconUrl,
  selectActivePluginIconTheme
} from '../../../../shared/plugins/plugin-file-icon-resolution'
import { usePluginIconThemes } from '@/store/plugin-icon-themes'

type ThemedFileIconProps = {
  /** Path or filename the icon represents. */
  filePath: string | undefined | null
  className?: string
}

/**
 * Renders a contributed plugin icon when a theme claims the file, otherwise
 * Orca's built-in Lucide icon.
 *
 * Why <img>: SVG loaded through an image element cannot run script or fetch
 * subresources, so plugin-authored markup never becomes renderer-privileged.
 */
export function ThemedFileIcon({ filePath, className }: ThemedFileIconProps): React.JSX.Element {
  const themes = usePluginIconThemes()
  const theme = selectActivePluginIconTheme(themes)
  const iconUrl = resolvePluginFileIconUrl(theme, filePath)

  if (iconUrl) {
    return <img src={iconUrl} alt="" aria-hidden className={className} draggable={false} />
  }

  const FileIcon = getFileTypeIcon(filePath)
  return <FileIcon className={className} />
}
