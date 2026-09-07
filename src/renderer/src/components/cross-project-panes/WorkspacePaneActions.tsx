import { Columns2, Maximize2, Minimize2, X } from 'lucide-react'
import { useAppStore } from '@/store'
import { Button } from '../ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip'
import { WorkspaceWindowMenu } from './WorkspaceWindowMenu'

export function WorkspacePaneActions({
  paneId,
  expanded,
  split
}: {
  paneId: string
  expanded: boolean
  split: boolean
}) {
  const actions = [
    {
      label: 'Split Right',
      icon: Columns2,
      run: () => useAppStore.getState().splitWindowPane(paneId, 'horizontal')
    },
    {
      label: expanded ? 'Restore Layout' : 'Expand Pane',
      icon: expanded ? Minimize2 : Maximize2,
      run: () => useAppStore.getState().expandWindowPane(paneId)
    },
    ...(split
      ? [
          {
            label: 'Close Pane',
            icon: X,
            run: () => useAppStore.getState().closeWindowPane(paneId)
          }
        ]
      : [])
  ]
  return (
    <div
      className="flex items-center shrink-0"
      style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
    >
      {actions.map(({ label, icon: Icon, run }) => (
        <Tooltip key={label}>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon-xs" aria-label={label} onClick={run}>
              <Icon />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{label}</TooltipContent>
        </Tooltip>
      ))}
      <WorkspaceWindowMenu paneId={paneId} />
    </div>
  )
}
