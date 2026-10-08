import { createElement } from 'react'
import { GitCompareArrows, Eye, ShieldAlert, ListChecks } from 'lucide-react'
import { getFileTypeIcon } from '@/lib/file-type-icons'
import type { OpenFile } from '../../store/slices/editor'

export function EditorFileTabIcon({
  file,
  isActive
}: {
  file: OpenFile
  isActive: boolean
}): React.JSX.Element {
  const FileIcon = getFileTypeIcon(file.filePath)
  const iconClassName = `w-3 h-3 mr-1 shrink-0 ${isActive ? 'text-foreground' : 'text-muted-foreground'}`

  if (file.mode === 'conflict-review') {
    return (
      <ShieldAlert
        className={`w-3 h-3 mr-1 shrink-0 ${isActive ? 'text-orange-400' : 'text-orange-400/70'}`}
      />
    )
  }
  if (file.mode === 'check-details') {
    return <ListChecks className={iconClassName} />
  }
  if (file.mode === 'diff') {
    return <GitCompareArrows className={iconClassName} />
  }
  if (file.mode === 'markdown-preview') {
    return (
      <Eye
        className={`w-3.5 h-3.5 mr-1.5 shrink-0 ${isActive ? 'text-foreground' : 'text-muted-foreground'}`}
      />
    )
  }
  return createElement(FileIcon, { className: iconClassName })
}
