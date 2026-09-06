import { Loader2 } from 'lucide-react'
import { translate } from '@/i18n/i18n'

export function TerminalRichInputAttachmentPending({
  pending
}: {
  pending: boolean
}): React.JSX.Element | null {
  if (!pending) {
    return null
  }
  return (
    <div className="mx-2 mb-1 flex items-center gap-1.5 text-xs text-muted-foreground">
      <Loader2 className="size-3.5 shrink-0 animate-spin" />
      {translate('components.terminal.richInput.addingImage', 'Adding image…')}
    </div>
  )
}
