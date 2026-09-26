import { Copy } from 'lucide-react'
import { toast } from 'sonner'
import { DropdownMenuItem } from '@/components/ui/dropdown-menu'
import { translate } from '@/i18n/i18n'

/**
 * Copies the chat's orchestration address (`session:<id>`), the one other agents message it by,
 * resolved when selected because `/clear` keeps the conversation's address, not the live id.
 * Distinct from "Copy Session ID", which copies the provider's id and changes on `/clear`.
 */
export function NativeChatCopyAddressMenuItem({
  resolveAddress
}: {
  resolveAddress: () => Promise<string | null>
}): React.JSX.Element {
  const copyAddress = async (): Promise<void> => {
    try {
      const address = await resolveAddress()
      if (!address) {
        throw new Error('no orchestration address')
      }
      await window.api.ui.writeClipboardText(address)
      toast.success(
        translate(
          'components.native-chat.contextMenu.orchestrationAddressCopied',
          'Orchestration address copied'
        )
      )
    } catch {
      toast.error(
        translate(
          'components.native-chat.contextMenu.orchestrationAddressCopyFailed',
          'Unable to copy orchestration address'
        )
      )
    }
  }
  return (
    <DropdownMenuItem onSelect={() => void copyAddress()}>
      <Copy />
      {translate(
        'components.native-chat.contextMenu.copyOrchestrationAddress',
        'Copy Orchestration Address'
      )}
    </DropdownMenuItem>
  )
}
