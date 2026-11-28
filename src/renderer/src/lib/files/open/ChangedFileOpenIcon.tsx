import { Eye, FileText, Globe } from 'lucide-react'
import type { ChangedFileOpenTarget } from './changed-file-view'

export function ChangedFileOpenIcon({
  target,
  className
}: {
  target: ChangedFileOpenTarget
  className?: string
}): React.JSX.Element {
  const Icon = target === 'orca-browser' ? Globe : target === 'editor' ? FileText : Eye
  return <Icon aria-hidden className={className} />
}
