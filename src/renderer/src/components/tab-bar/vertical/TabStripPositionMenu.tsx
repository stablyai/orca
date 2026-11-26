import type React from 'react'
import { PanelLeft, PanelLeftClose, PanelLeftOpen, PanelTop } from 'lucide-react'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger
} from '@/components/ui/context-menu'
import { useTranslate } from '@/i18n/use-translate'
import { useAppStore } from '@/store/index'
import {
  normalizeTabStripPosition,
  type TabStripPosition
} from '../../../../../shared/workspace-layout/tab-strip-position'

export function useTabStripPosition(): TabStripPosition {
  return useAppStore((state) => normalizeTabStripPosition(state.settings?.tabStripPosition))
}

/**
 * Right-click on the strip's (or list's) empty space switches where tabs render, like Chrome's
 * "Show tabs to the side". Tabs open their own menus first; Radix skips this one once they have.
 */
export function TabStripPositionMenu({
  children
}: {
  children: React.ReactElement
}): React.JSX.Element {
  const t = useTranslate()
  const position = useTabStripPosition()
  const updateSettings = useAppStore((state) => state.updateSettings)
  const collapsed = useAppStore((state) => state.verticalTabListCollapsed)
  const setCollapsed = useAppStore((state) => state.setVerticalTabListCollapsed)
  return (
    <ContextMenu modal={false}>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent
        animation="none"
        className="min-w-[13rem] max-w-[calc(100vw-1rem)] whitespace-nowrap"
      >
        {position === 'left' ? (
          <>
            <ContextMenuItem onSelect={() => void updateSettings({ tabStripPosition: 'top' })}>
              <PanelTop className="size-3.5" />
              {t(
                'auto.components.tab.bar.vertical.TabStripPositionMenu.54f7297602',
                'Show Tabs at the Top'
              )}
            </ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem onSelect={() => setCollapsed(!collapsed)}>
              {collapsed ? (
                <PanelLeftOpen className="size-3.5" />
              ) : (
                <PanelLeftClose className="size-3.5" />
              )}
              {collapsed
                ? t(
                    'auto.components.tab.bar.vertical.TabStripPositionMenu.97b6456a5d',
                    'Expand Tab List'
                  )
                : t(
                    'auto.components.tab.bar.vertical.TabStripPositionMenu.4f597a791a',
                    'Collapse Tab List'
                  )}
            </ContextMenuItem>
          </>
        ) : (
          <ContextMenuItem onSelect={() => void updateSettings({ tabStripPosition: 'left' })}>
            <PanelLeft className="size-3.5" />
            {t(
              'auto.components.tab.bar.vertical.TabStripPositionMenu.bd0acddbce',
              'Show Tabs on the Left'
            )}
          </ContextMenuItem>
        )}
      </ContextMenuContent>
    </ContextMenu>
  )
}
