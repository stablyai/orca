import { ArrowRight, ExternalLink } from 'lucide-react'
import type { PlaneWorkItem } from '../../../shared/plane-types'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'

export function TaskPagePlaneWorkItemList({
  items,
  onStartWorkspace
}: {
  items: PlaneWorkItem[]
  onStartWorkspace: (item: PlaneWorkItem) => void
}): React.JSX.Element {
  return (
    <div className="divide-y divide-border/50">
      {items.map((item) => (
        <div
          key={item.id}
          className="group grid min-h-12 grid-cols-[90px_minmax(0,1fr)_128px_100px_64px] items-center gap-3 px-3 py-2 hover:bg-accent"
        >
          <span className="truncate font-mono text-xs text-muted-foreground">{item.key}</span>
          <div className="min-w-0">
            <p className="truncate text-[13px] font-medium text-foreground">{item.title}</p>
            <p className="mt-1 truncate text-[11px] text-muted-foreground">{item.project.name}</p>
          </div>
          <span className="truncate text-xs text-muted-foreground">{item.state.name}</span>
          <span className="truncate text-xs text-muted-foreground">
            {item.assignees[0]?.displayName ??
              translate('auto.components.TaskPagePlaneWorkItemList.unassigned', 'Unassigned')}
          </span>
          <div className="flex justify-end gap-1 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  size="icon-xs"
                  variant="ghost"
                  onClick={() => onStartWorkspace(item)}
                  aria-label={translate(
                    'auto.components.TaskPagePlaneWorkItemList.start',
                    'Start workspace from {{key}}',
                    { key: item.key }
                  )}
                >
                  <ArrowRight />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">
                {translate(
                  'auto.components.TaskPagePlaneWorkItemList.startWorkspace',
                  'Start workspace'
                )}
              </TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  size="icon-xs"
                  variant="ghost"
                  onClick={() => void window.api.shell.openUrl(item.url)}
                  aria-label={translate(
                    'auto.components.TaskPagePlaneWorkItemList.open',
                    'Open {{key}} in Plane',
                    { key: item.key }
                  )}
                >
                  <ExternalLink />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">
                {translate('auto.components.TaskPagePlaneWorkItemList.openPlane', 'Open in Plane')}
              </TooltipContent>
            </Tooltip>
          </div>
        </div>
      ))}
    </div>
  )
}
