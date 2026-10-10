import { Copy } from 'lucide-react'
import { toast } from 'sonner'
import { DropdownMenuItem } from '@/components/ui/dropdown-menu'
import { translate } from '@/i18n/i18n'

export function CopyTabIdMenuItem({ unifiedTabId }: { unifiedTabId: string }): React.JSX.Element {
  const copyTabId = async (): Promise<void> => {
    try {
      await window.api.ui.writeClipboardText(`orcaTabId: ${unifiedTabId}`)
      toast.success(translate('components.tab.bar.CopyTabIdMenuItem.copied', 'Tab ID copied'))
    } catch {
      toast.error(translate('components.tab.bar.CopyTabIdMenuItem.failed', 'Could not copy tab ID'))
    }
  }

  return (
    <DropdownMenuItem onSelect={() => void copyTabId()}>
      <Copy className="size-3.5" />
      {translate('components.tab.bar.CopyTabIdMenuItem.copy', 'Copy Tab ID')}
    </DropdownMenuItem>
  )
}
