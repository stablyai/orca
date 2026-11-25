import type React from 'react'
import { PanelLeftClose, PanelLeftOpen, Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useTranslate } from '@/i18n/use-translate'
import { useAppStore } from '@/store/index'
import { cn } from '@/lib/class-names'
import type { TabBarProps } from '../tab-bar-props'
import type { TabBarModel } from '../model/use-tab-bar-model'
import { TabBarNewTabMenu } from '../create-menu/TabBarNewTabMenu'

/** The list's top: "New tab" (the strip's "+" menu) and the icons-only toggle, as in Chrome. */
export function VerticalTabListHeader({
  props,
  model,
  collapsed,
  excludedTabId
}: {
  props: TabBarProps
  model: TabBarModel
  collapsed: boolean
  excludedTabId: string | null
}): React.JSX.Element {
  const t = useTranslate()
  const setCollapsed = useAppStore((state) => state.setVerticalTabListCollapsed)
  const newTabLabel = t('auto.components.tab.bar.TabBar.b1a132357f', 'New tab')
  const toggleLabel = collapsed
    ? t('auto.components.tab.bar.vertical.VerticalTabListHeader.4214491c78', 'Expand tab list')
    : t('auto.components.tab.bar.vertical.VerticalTabListHeader.a08e96025f', 'Collapse tab list')
  const ToggleIcon = collapsed ? PanelLeftOpen : PanelLeftClose
  return (
    <div
      className={cn(
        'flex shrink-0 gap-0.5 p-1',
        collapsed ? 'flex-col items-center' : 'flex-row items-center'
      )}
    >
      <TabBarNewTabMenu
        props={props}
        runtime={model.runtime}
        createMenu={model.createMenu}
        excludedTabId={excludedTabId}
        bot={model.bot}
        botGroup={model.botGroup}
        align="start"
        side="right"
      >
        <button
          type="button"
          className={cn(
            'flex h-7 min-w-0 items-center gap-2 rounded-md text-xs text-muted-foreground hover:bg-accent/50 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
            collapsed ? 'w-7 justify-center' : 'flex-1 px-2'
          )}
          title={newTabLabel}
          aria-label={newTabLabel}
          data-contextual-tour-target="tab-create-menu"
        >
          <Plus className="size-3.5 shrink-0" />
          {collapsed ? null : <span className="truncate">{newTabLabel}</span>}
        </button>
      </TabBarNewTabMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost-muted"
            size="icon-xs"
            className={cn('shrink-0', collapsed && 'order-first')}
            aria-label={toggleLabel}
            aria-expanded={!collapsed}
            onClick={() => setCollapsed(!collapsed)}
          >
            <ToggleIcon className="size-3.5" />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="right" sideOffset={6}>
          {toggleLabel}
        </TooltipContent>
      </Tooltip>
    </div>
  )
}
