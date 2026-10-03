import { createElement } from 'react'
import { Eye, GitCompareArrows, ListChecks, ShieldAlert } from 'lucide-react'
import { getFileTypeIcon } from '@/lib/file-type-icons'
import { cn } from '@/lib/utils'
import type { OpenFile } from '@/store/slices/editor'

export function EditorFileTabLeadingIcon({
  filePath,
  mode,
  isActive
}: {
  filePath: string
  mode: OpenFile['mode']
  isActive: boolean
}): React.JSX.Element {
  const iconClassName = cn(
    'mr-1 size-3 shrink-0',
    isActive ? 'text-foreground' : 'text-muted-foreground'
  )
  if (mode === 'conflict-review') {
    return (
      <ShieldAlert
        className={cn(
          'mr-1 size-3 shrink-0',
          isActive ? 'text-status-warning' : 'text-status-warning/70'
        )}
      />
    )
  }
  if (mode === 'check-details') {
    return <ListChecks className={iconClassName} />
  }
  if (mode === 'diff') {
    return <GitCompareArrows className={iconClassName} />
  }
  if (mode === 'markdown-preview') {
    return (
      <Eye
        className={cn(
          'mr-1.5 size-3.5 shrink-0',
          isActive ? 'text-foreground' : 'text-muted-foreground'
        )}
      />
    )
  }
  const FileIcon = getFileTypeIcon(filePath)
  return createElement(FileIcon, { className: iconClassName })
}
