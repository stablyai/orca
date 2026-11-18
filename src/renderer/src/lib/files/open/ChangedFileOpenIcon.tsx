import { Eye, FileText, Globe } from 'lucide-react'
import type { ChangedFileOpenTarget } from './changed-file-view'

/** A file's open destination, plus a chat attachment's own preview. */
export type FileOpenGlyph = ChangedFileOpenTarget | 'attachment-preview'

export function ChangedFileOpenIcon({
  target,
  className
}: {
  target: FileOpenGlyph
  className?: string
}): React.JSX.Element {
  const Icon = target === 'orca-browser' ? Globe : target === 'editor' ? FileText : Eye
  return <Icon aria-hidden className={className} />
}
