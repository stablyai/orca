import { Copy } from 'lucide-react'
import { toast } from 'sonner'
import { DropdownMenuItem } from '@/components/ui/dropdown-menu'
import { translate } from '@/i18n/i18n'

export function NativeChatProviderSessionIdMenuItem({
  sessionId
}: {
  sessionId: string
}): React.JSX.Element {
  const copy = async (): Promise<void> => {
    try {
      await window.api.ui.writeTerminalClipboardText(sessionId)
      toast.success(
        translate(
          'components.terminalPane.TerminalContextMenu.copySessionIdSuccess',
          'Session ID copied'
        )
      )
    } catch {
      toast.error(
        translate(
          'components.terminalPane.TerminalContextMenu.copySessionIdError',
          'Unable to copy session ID'
        )
      )
    }
  }
  return (
    <DropdownMenuItem onSelect={() => void copy()}>
      <Copy />
      {translate('components.terminalPane.TerminalContextMenu.copySessionId', 'Copy Session ID')}
    </DropdownMenuItem>
  )
}
