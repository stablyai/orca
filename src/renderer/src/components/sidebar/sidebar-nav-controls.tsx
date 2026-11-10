import React from 'react'
import { EyeOff } from 'lucide-react'
import { ContextMenuContent, ContextMenuItem } from '@/components/ui/context-menu'
import { useTranslate } from '@/i18n/use-translate'

export function HideSidebarMenu({ onHide }: { onHide: () => void }): React.JSX.Element {
  const t = useTranslate()
  return (
    <ContextMenuContent>
      <ContextMenuItem onSelect={onHide}>
        <EyeOff className="size-3.5" />
        {t('auto.components.sidebar.SidebarNav.d599269755', 'Hide from sidebar')}
      </ContextMenuItem>
    </ContextMenuContent>
  )
}
