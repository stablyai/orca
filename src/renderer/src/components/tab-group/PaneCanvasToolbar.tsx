import type { ReactNode } from 'react'
import { AlignStartVertical, Columns3, LayoutDashboard } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import {
  paneCanvasToolbarTrailingInsetClassName,
  type PaneCanvasToolbarTrailingInset
} from './pane-canvas-toolbar-chrome'

export function PaneCanvasToolbarAction({
  label,
  icon,
  onClick
}: {
  label: string
  icon: ReactNode
  onClick: () => void
}): React.JSX.Element {
  const button = (
    <Button
      type="button"
      variant="ghost"
      size="icon-xs"
      aria-label={label}
      data-pane-canvas-toolbar-control="true"
      onClick={onClick}
    >
      {icon}
    </Button>
  )
  return (
    <Tooltip>
      <TooltipTrigger asChild>{button}</TooltipTrigger>
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  )
}

export function PaneCanvasToolbar({
  title,
  showSplitsButton,
  trailingChromeInset,
  toolbarContent,
  onShowSplits,
  onArrange
}: {
  title?: string
  showSplitsButton: boolean
  trailingChromeInset: PaneCanvasToolbarTrailingInset
  toolbarContent?: ReactNode
  onShowSplits: () => void
  onArrange: () => void
}): React.JSX.Element {
  return (
    <div
      className={`relative z-50 flex h-8 shrink-0 items-center gap-1 border-b border-border bg-card px-2${paneCanvasToolbarTrailingInsetClassName(
        trailingChromeInset
      )}`}
      data-pane-canvas-toolbar="true"
      data-terminal-focus-release-surface="true"
    >
      <LayoutDashboard className="size-3.5 text-muted-foreground" />
      <span className="mr-2 text-xs font-medium text-foreground">
        {title ?? translate('auto.components.tab.group.TabGroupCanvasLayout.canvas', 'Canvas')}
      </span>
      <div className="ml-auto flex items-center gap-1" data-pane-canvas-toolbar-controls="true">
        {showSplitsButton ? (
          <PaneCanvasToolbarAction
            label={translate('auto.components.tab.group.TabGroupCanvasLayout.splits', 'Splits')}
            icon={<Columns3 />}
            onClick={onShowSplits}
          />
        ) : null}
        <PaneCanvasToolbarAction
          label={translate('auto.components.tab.group.TabGroupCanvasLayout.arrange', 'Arrange')}
          icon={<AlignStartVertical />}
          onClick={onArrange}
        />
        {toolbarContent}
      </div>
    </div>
  )
}
