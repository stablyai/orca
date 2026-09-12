import { Panel, useViewport } from '@xyflow/react'
import { Hand } from 'lucide-react'
import { translate } from '@/i18n/i18n'

export function AgentCanvasViewportHud() {
  const { zoom } = useViewport()
  return (
    <Panel
      position="bottom-left"
      className="pointer-events-none flex items-center gap-3 rounded-md border border-border bg-popover px-3 py-2 text-xs text-popover-foreground shadow-xs"
    >
      <Hand className="size-3.5 text-muted-foreground" />
      <span className="text-muted-foreground">
        {translate('agentCanvas.panHint', 'Drag the background to pan')}
      </span>
      <span className="border-l border-border pl-3 font-mono tabular-nums">
        {Math.round(zoom * 100)}%
      </span>
    </Panel>
  )
}
