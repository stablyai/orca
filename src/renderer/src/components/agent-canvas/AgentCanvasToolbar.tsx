import { Globe, Maximize, Minus, Plus, StickyNote } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import type { DashboardCard } from '../../../../shared/dashboard-snapshot'
import { AgentCanvasAgentMenu } from './AgentCanvasAgentMenu'
import type { TabAgentLaunchOption } from '../tab-bar/tab-agent-launch-options'
import type { TuiAgent } from '../../../../shared/tui-agent'

export function AgentCanvasToolbar({
  agents,
  launchOptions,
  launching,
  onLaunchAgent,
  readOnly,
  onAddAgent,
  onAddNode,
  onFit,
  onZoom
}: {
  agents: DashboardCard[]
  launchOptions: TabAgentLaunchOption[]
  launching: boolean
  onLaunchAgent: (agent: TuiAgent) => void
  readOnly: boolean
  onAddAgent: (card: DashboardCard) => void
  onAddNode: (kind: 'note' | 'browser') => void
  onFit: () => void
  onZoom: (direction: 'in' | 'out') => void
}) {
  const iconActions = [
    {
      label: translate('agentCanvas.zoomOut', 'Zoom out'),
      icon: Minus,
      action: () => onZoom('out')
    },
    { label: translate('agentCanvas.zoomIn', 'Zoom in'), icon: Plus, action: () => onZoom('in') },
    { label: translate('agentCanvas.fit', 'Fit canvas'), icon: Maximize, action: onFit }
  ]
  return (
    <div className="relative z-20 m-3 flex shrink-0 flex-wrap items-center gap-1 rounded-lg border border-border bg-popover p-2 text-popover-foreground shadow-xs">
      <AgentCanvasAgentMenu
        agents={agents}
        options={launchOptions}
        disabled={readOnly || launching}
        onLaunch={onLaunchAgent}
        onAttach={onAddAgent}
      />
      <Button variant="ghost" size="xs" disabled={readOnly} onClick={() => onAddNode('note')}>
        <StickyNote />
        {translate('agentCanvas.note', 'Note')}
      </Button>
      <Button variant="ghost" size="xs" disabled={readOnly} onClick={() => onAddNode('browser')}>
        <Globe />
        {translate('agentCanvas.browser', 'Browser')}
      </Button>
      <div className="ml-auto flex items-center gap-1">
        {iconActions.map(({ label, icon: Icon, action }) => (
          <Tooltip key={label}>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon-xs" aria-label={label} onClick={action}>
                <Icon />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{label}</TooltipContent>
          </Tooltip>
        ))}
      </div>
    </div>
  )
}
