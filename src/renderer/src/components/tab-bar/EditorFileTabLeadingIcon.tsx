import { createElement } from 'react'
import { GitCompareArrows, Eye, ShieldAlert, ListChecks, Smartphone } from 'lucide-react'
import { getFileTypeIcon } from '@/lib/file-type-icons'
import type { OpenFile } from '../../store/slices/editor'

// The tab's view mode outranks the file type: a diff or conflict-review tab of `App.tsx` reads as
// that view first, so only a plain edit tab falls through to the file-type glyph.
export function EditorFileTabLeadingIcon({
  file,
  isActive
}: {
  file: OpenFile
  isActive: boolean
}): React.JSX.Element {
  const tone = isActive ? 'text-foreground' : 'text-muted-foreground'
  if (file.mode === 'conflict-review') {
    return (
      <ShieldAlert
        className={`w-3 h-3 mr-1 shrink-0 ${isActive ? 'text-orange-400' : 'text-orange-400/70'}`}
      />
    )
  }
  if (file.mode === 'check-details') {
    return <ListChecks className={`w-3 h-3 mr-1 shrink-0 ${tone}`} />
  }
  if (file.mode === 'diff') {
    return <GitCompareArrows className={`w-3 h-3 mr-1 shrink-0 ${tone}`} />
  }
  if (file.mode === 'markdown-preview') {
    return <Eye className={`w-3.5 h-3.5 mr-1.5 shrink-0 ${tone}`} />
  }
  // Simulator tabs borrow this chrome with a device name ("iPhone 16 Pro") as their filePath, which
  // has no extension to type off — without this they fall through to a generic document glyph.
  if (file.language === 'simulator') {
    return <Smartphone className={`w-3 h-3 mr-1 shrink-0 ${tone}`} />
  }
  return createElement(getFileTypeIcon(file.filePath), {
    className: `w-3 h-3 mr-1 shrink-0 ${tone}`
  })
}
