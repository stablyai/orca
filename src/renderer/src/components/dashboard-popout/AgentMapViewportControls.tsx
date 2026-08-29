import { Focus, Minus, Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'

type AgentMapViewportControlsProps = {
  zoom: number
  onFit: () => void
  onZoomIn: () => void
  onZoomOut: () => void
}

export function AgentMapViewportControls({
  zoom,
  onFit,
  onZoomIn,
  onZoomOut
}: AgentMapViewportControlsProps): React.JSX.Element {
  return (
    <div className="absolute bottom-3 left-3 flex items-center gap-0.5 rounded-md border border-border bg-card p-0.5 shadow-xs">
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        aria-label={translate('dashboardPopout.map.zoomOut', 'Zoom out')}
        onClick={onZoomOut}
      >
        <Minus className="size-3" />
      </Button>
      <span className="min-w-12 text-center text-[10px] text-muted-foreground tabular-nums">
        {Math.round(zoom * 100)}%
      </span>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        aria-label={translate('dashboardPopout.map.zoomIn', 'Zoom in')}
        onClick={onZoomIn}
      >
        <Plus className="size-3" />
      </Button>
      <Button type="button" variant="ghost" size="xs" onClick={onFit}>
        <Focus className="size-3" />
        {translate('dashboardPopout.map.fit', 'Fit')}
      </Button>
    </div>
  )
}
