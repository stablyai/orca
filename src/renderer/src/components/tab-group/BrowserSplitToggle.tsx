import { PanelLeftClose, PanelLeftOpen } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'

export type BrowserSplitFold = {
  groupId: string | null
  setFold: (target: { groupId: string; tabId: string } | null) => void
}

export function BrowserSplitToggle({
  side,
  collapsed,
  onToggle
}: {
  side: 'left' | 'right'
  collapsed: boolean
  onToggle: () => void
}) {
  const label = collapsed
    ? translate('auto.components.tab.group.TabGroupPanel.expandBrowser', 'Expand webpage')
    : translate('auto.components.tab.group.TabGroupPanel.collapseBrowser', 'Collapse webpage')
  const Icon = collapsed ? PanelLeftOpen : PanelLeftClose
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          aria-label={label}
          aria-expanded={!collapsed}
          onClick={onToggle}
          className="size-7"
        >
          <Icon className={side === 'right' ? 'size-4 rotate-180' : 'size-4'} />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  )
}
