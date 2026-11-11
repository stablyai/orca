import { toast } from 'sonner'
import { ContextMenuItem } from '@/components/ui/context-menu'
import { DropdownMenuItem } from '@/components/ui/dropdown-menu'
import { useTranslate } from '@/i18n/use-translate'

export function CopyTabIdMenuItem({
  unifiedTabId,
  menuKind = 'dropdown'
}: {
  unifiedTabId: string
  menuKind?: 'dropdown' | 'context'
}): React.JSX.Element {
  const t = useTranslate()
  const Item = menuKind === 'context' ? ContextMenuItem : DropdownMenuItem
  const copyTabId = async (): Promise<void> => {
    try {
      await window.api.ui.writeClipboardText(`orcaTabId: ${unifiedTabId}`)
      toast.success(t('components.tab.bar.CopyTabIdMenuItem.copied', 'Tab ID copied'))
    } catch {
      toast.error(t('components.tab.bar.CopyTabIdMenuItem.failed', 'Could not copy tab ID'))
    }
  }

  return (
    <Item inset onSelect={() => void copyTabId()}>
      {t('components.tab.bar.CopyTabIdMenuItem.copy', 'Copy Tab ID')}
    </Item>
  )
}
