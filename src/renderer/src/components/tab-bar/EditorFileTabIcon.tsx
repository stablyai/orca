import { GitCompareArrows, Eye, ShieldAlert, ListChecks } from 'lucide-react'
import type { OpenFile } from '../../store/slices/editor'

export function EditorFileTabIcon({
  mode,
  isActive,
  FileIcon
}: {
  mode: OpenFile['mode']
  isActive: boolean
  FileIcon: React.ComponentType<{ className?: string }>
}): React.JSX.Element {
  if (mode === 'conflict-review') {
    return (
      <ShieldAlert
        className={`w-3 h-3 mr-1 shrink-0 ${isActive ? 'text-orange-400' : 'text-orange-400/70'}`}
      />
    )
  }
  if (mode === 'check-details') {
    return (
      <ListChecks
        className={`w-3 h-3 mr-1 shrink-0 ${isActive ? 'text-foreground' : 'text-muted-foreground'}`}
      />
    )
  }
  if (mode === 'diff') {
    return (
      <GitCompareArrows
        className={`w-3 h-3 mr-1 shrink-0 ${isActive ? 'text-foreground' : 'text-muted-foreground'}`}
      />
    )
  }
  if (mode === 'markdown-preview') {
    return (
      <Eye
        className={`w-3.5 h-3.5 mr-1.5 shrink-0 ${isActive ? 'text-foreground' : 'text-muted-foreground'}`}
      />
    )
  }
  return (
    <FileIcon
      className={`w-3 h-3 mr-1 shrink-0 ${isActive ? 'text-foreground' : 'text-muted-foreground'}`}
    />
  )
}
