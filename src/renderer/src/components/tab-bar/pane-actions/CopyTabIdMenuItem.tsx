import { Copy } from 'lucide-react'
import { toast } from 'sonner'
import { ContextMenuItem } from '@/components/ui/context-menu'
import { DropdownMenuItem } from '@/components/ui/dropdown-menu'
import { useTranslate } from '@/i18n/use-translate'
import { formatTabReference, type TabReference } from './tab-reference'

export function CopyTabIdMenuItem({
  reference,
  menuKind = 'dropdown'
}: {
  reference: TabReference
  menuKind?: 'dropdown' | 'context'
}): React.JSX.Element {
  const t = useTranslate()
  const Item = menuKind === 'context' ? ContextMenuItem : DropdownMenuItem
  const copyTabId = async (): Promise<void> => {
    try {
      await window.api.ui.writeClipboardText(formatTabReference(reference))
      toast.success(t('components.tab.bar.CopyTabIdMenuItem.copied', 'Tab ID copied'))
    } catch {
      toast.error(t('components.tab.bar.CopyTabIdMenuItem.failed', 'Could not copy tab ID'))
    }
  }

  return (
    <Item onSelect={() => void copyTabId()}>
      <Copy className="size-3.5" />
      {t('components.tab.bar.CopyTabIdMenuItem.copy', 'Copy Tab ID')}
    </Item>
  )
}
