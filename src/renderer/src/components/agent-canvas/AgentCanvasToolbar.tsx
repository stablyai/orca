import { Globe, Maximize, Minus, Pause, Play, Plus, StickyNote, Undo2, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import type { DashboardCard } from '../../../../shared/dashboard-snapshot'
import type { CanvasNode } from './agent-canvas-document'
import { AgentCanvasAgentMenu } from './AgentCanvasAgentMenu'
import type { TabAgentLaunchOption } from '../tab-bar/tab-agent-launch-options'
import type { TuiAgent } from '../../../../shared/tui-agent'

export function AgentCanvasToolbar({
  agents,
  launchOptions,
  launching,
  onLaunchAgent,
  selected,
  readOnly,
  canUndo,
  onAddAgent,
  onAddNode,
  onRemove,
  onUndo,
  onFit,
  onZoom,
  collaborationPaused,
  onToggleCollaboration
}: {
  agents: DashboardCard[]
  launchOptions: TabAgentLaunchOption[]
  launching: boolean
  onLaunchAgent: (agent: TuiAgent) => void
  selected: CanvasNode | undefined
  readOnly: boolean
  canUndo: boolean
  onAddAgent: (card: DashboardCard) => void
  onAddNode: (kind: 'note' | 'browser') => void
  onRemove: () => void
  onUndo: () => void
  onFit: () => void
  onZoom: (direction: 'in' | 'out') => void
  collaborationPaused?: boolean
  onToggleCollaboration?: () => void
}) {
  const iconActions = [
    {
      label: translate('agentCanvas.undo', 'Undo canvas edit'),
      icon: Undo2,
      action: onUndo,
      disabled: !canUndo || readOnly
    },
    {
      label: translate('agentCanvas.zoomOut', 'Zoom out'),
      icon: Minus,
      action: () => onZoom('out')
    },
    { label: translate('agentCanvas.zoomIn', 'Zoom in'), icon: Plus, action: () => onZoom('in') },
    { label: translate('agentCanvas.fit', 'Fit canvas'), icon: Maximize, action: onFit }
  ]
  return (
    <div className="absolute left-3 right-3 top-3 z-20 flex flex-wrap items-center gap-1 rounded-lg border border-border bg-popover p-2 text-popover-foreground shadow-xs">
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
      {selected && (
        <Button variant="ghost" size="xs" disabled={readOnly} onClick={onRemove}>
          <X />
          {translate('agentCanvas.removeNode', 'Remove from canvas')}
        </Button>
      )}
      <div className="ml-auto flex items-center gap-1">
        {onToggleCollaboration && (
          <Button
            variant="ghost"
            size="xs"
            disabled={readOnly}
            aria-pressed={collaborationPaused === true}
            onClick={onToggleCollaboration}
          >
            {collaborationPaused ? <Play /> : <Pause />}
            {collaborationPaused
              ? translate('agentCanvas.resumeCollaboration', 'Resume collaboration')
              : translate('agentCanvas.pauseCollaboration', 'Pause collaboration')}
          </Button>
        )}
        {iconActions.map(({ label, icon: Icon, action, disabled }) => (
          <Tooltip key={label}>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label={label}
                disabled={disabled}
                onClick={action}
              >
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
