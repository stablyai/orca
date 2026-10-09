import { Copy } from 'lucide-react'
import { toast } from 'sonner'
import { DropdownMenuItem } from '@/components/ui/dropdown-menu'
import { translate } from '@/i18n/i18n'
import { describeTabLocation } from './workspace-tab-location'

export function CopyTabDetailsMenuItem({
  unifiedTabId,
  groupId
}: {
  unifiedTabId: string
  groupId: string
}): React.JSX.Element {
  const copyDetails = async (): Promise<void> => {
    try {
      const details = describeTabLocation(unifiedTabId, groupId)
      await window.api.ui.writeClipboardText(JSON.stringify(details, null, 2))
      toast.success(
        translate('components.tab.bar.CopyTabDetailsMenuItem.copied', 'Tab details copied')
      )
    } catch {
      toast.error(
        translate('components.tab.bar.CopyTabDetailsMenuItem.failed', 'Could not copy tab details')
      )
    }
  }
  return (
    <DropdownMenuItem onSelect={() => void copyDetails()}>
      <Copy className="size-3.5" />
      {translate('components.tab.bar.CopyTabDetailsMenuItem.copy', 'Copy Tab Details')}
    </DropdownMenuItem>
  )
}
