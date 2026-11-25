import { Copy } from 'lucide-react'
import { toast } from 'sonner'
import { DropdownMenuItem } from '@/components/ui/dropdown-menu'
import { useTranslate } from '@/i18n/use-translate'

export function NativeChatProviderSessionIdMenuItem({
  sessionId
}: {
  sessionId: string
}): React.JSX.Element {
  const t = useTranslate()
  const copy = async (): Promise<void> => {
    try {
      await window.api.ui.writeTerminalClipboardText(sessionId)
      toast.success(
        t('components.terminalPane.TerminalContextMenu.copySessionIdSuccess', 'Session ID copied')
      )
    } catch {
      toast.error(
        t(
          'components.terminalPane.TerminalContextMenu.copySessionIdError',
          'Unable to copy session ID'
        )
      )
    }
  }
  return (
    <DropdownMenuItem onSelect={() => void copy()}>
      <Copy />
      {t('components.terminalPane.TerminalContextMenu.copySessionId', 'Copy Session ID')}
    </DropdownMenuItem>
  )
}
