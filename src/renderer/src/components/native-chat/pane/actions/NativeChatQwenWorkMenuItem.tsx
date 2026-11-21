import { useQwenWorkAvailable } from '@/hooks/useQwenWorkAvailable'
import { ExternalLink } from 'lucide-react'
import { toast } from 'sonner'
import { DropdownMenuItem } from '@/components/ui/dropdown-menu'
import { useTranslate } from '@/i18n/use-translate'

export function NativeChatQwenWorkMenuItem({ text }: { text: string }): React.JSX.Element | null {
  const t = useTranslate()
  const available = useQwenWorkAvailable()

  if (!available) {
    return null
  }
  const copyAndOpen = async (): Promise<void> => {
    try {
      await window.api.ui.writeClipboardText(text)
    } catch {
      toast.error(t('components.native-chat.copyMessage.copyFailed', 'Could not copy message'))
      return
    }
    try {
      await window.api.shell.openQwenWork()
    } catch {
      toast.error(
        t(
          'components.native-chat.copyMessage.qwenWorkOpenFailed',
          'Message copied. Could not open QwenWork.'
        )
      )
    }
  }

  return (
    <DropdownMenuItem onSelect={() => void copyAndOpen()}>
      <ExternalLink />
      {t('components.native-chat.copyMessage.openQwenWork', 'Copy and open QwenWork')}
    </DropdownMenuItem>
  )
}
