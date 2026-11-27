import React from 'react'
import { EyeOff } from 'lucide-react'
import { ContextMenuContent, ContextMenuItem } from '@/components/ui/context-menu'
import { useTranslate } from '@/i18n/use-translate'

// Why opacity, not an alpha color: per-stroke alpha brightens where strokes overlap; forced colors keep opacity.
export const SIDEBAR_NAV_DIMMED_ICON_CLASS_NAME =
  'text-worktree-sidebar-foreground opacity-30 forced-colors:opacity-100'

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
