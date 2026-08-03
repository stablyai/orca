import React, { useCallback } from 'react'
import { Box, Copy, Server, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuTrigger
} from '@/components/ui/context-menu'
import { cn } from '@/lib/utils'
import {
  canNotifyLaunchingAgent,
  type WorkspaceService,
  type WorkspaceServiceStopRequest
} from '../../../../shared/workspace-services'
import { translate } from '@/i18n/i18n'

/** Shown wherever a value could not be resolved. Never replaced by a guess. */
export const UNRESOLVED = '—'

export function ServiceRow({
  service,
  showProject,
  onStop,
  stopRequest
}: {
  service: WorkspaceService
  showProject: boolean
  onStop: ((request: WorkspaceServiceStopRequest, notifyAgent: boolean) => void) | null
  stopRequest: WorkspaceServiceStopRequest | null
}): React.JSX.Element {
  const handleCopy = useCallback(() => {
    void window.api.ui.writeClipboardText(service.address)
  }, [service.address])

  // Why not `service.pid`: a container's pid is the shared docker proxy, and a
  // process with no workspace owner is refused by the main-process guard. A
  // button that always fails is worse than no button.
  const canStop = Boolean(onStop && stopRequest)
  // Why: a container's listener is the docker proxy, so processName reads
  // `com.docker.backend` for every one of them. The container name is what
  // distinguishes them.
  const secondary =
    service.container?.containerName ?? service.launchCommand ?? service.processName ?? UNRESOLVED

  const canTellAgent = canStop && canNotifyLaunchingAgent(service)

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div className="group flex items-center gap-2 rounded px-1 py-1 transition-colors hover:bg-accent/50">
          <div className="flex size-5 shrink-0 items-center justify-center text-muted-foreground">
            {service.kind === 'container' ? <Box size={13} /> : <Server size={13} />}
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-center gap-1.5">
              <span className="shrink-0 text-xs font-medium text-foreground">:{service.port}</span>
              <span className="truncate text-xs text-foreground" title={service.serviceName ?? ''}>
                {service.serviceName ?? UNRESOLVED}
              </span>
              {service.launchedByAgent && (
                <span
                  className="shrink-0 rounded bg-accent px-1 text-[10px] text-muted-foreground"
                  title={translate(
                    'auto.components.right.sidebar.ServiceRow.7a16db1af7',
                    'Started by {{value0}}',
                    { value0: service.launchedByAgent }
                  )}
                >
                  {service.launchedByAgent}
                </span>
              )}
            </div>
            <div className="flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground">
              <span className="truncate" title={secondary}>
                {secondary}
              </span>
            </div>
            {showProject && (
              <div className="flex min-w-0 items-center gap-1.5 text-[10px] text-muted-foreground/70">
                <span className="truncate" title={service.workingDir ?? ''}>
                  {service.projectName ?? UNRESOLVED}
                </span>
                {service.isOrphan && (
                  <span className="shrink-0 text-destructive">
                    {translate(
                      'auto.components.right.sidebar.ServiceRow.578fb812fd',
                      'workspace deleted'
                    )}
                  </span>
                )}
              </div>
            )}
          </div>
          <div className="flex items-center gap-0.5 transition-opacity can-hover:opacity-0 group-focus-within:opacity-100 group-hover:opacity-100">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  className="text-muted-foreground hover:text-foreground"
                  onClick={handleCopy}
                  aria-label={translate(
                    'auto.components.right.sidebar.ServiceRow.74831c740a',
                    'Copy {{value0}}',
                    { value0: service.address }
                  )}
                >
                  <Copy size={13} />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="top" sideOffset={4}>
                {translate('auto.components.right.sidebar.ServiceRow.39a29cea44', 'Copy Address')}
              </TooltipContent>
            </Tooltip>
            {canStop && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    className={cn('text-muted-foreground hover:text-destructive')}
                    onClick={() => stopRequest && onStop?.(stopRequest, false)}
                    aria-label={translate(
                      'auto.components.right.sidebar.ServiceRow.26b04179d6',
                      'Stop service on port {{value0}}',
                      { value0: service.port }
                    )}
                  >
                    <Trash2 size={13} />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="top" sideOffset={4}>
                  {translate('auto.components.right.sidebar.ServiceRow.d3775acb14', 'Stop Service')}
                </TooltipContent>
              </Tooltip>
            )}
          </div>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuLabel className="px-2 py-1 text-[11px] font-semibold text-muted-foreground">
          {`:${service.port}`}
        </ContextMenuLabel>
        <ContextMenuItem onSelect={handleCopy}>
          {translate('auto.components.right.sidebar.ServiceRow.39a29cea44', 'Copy Address')}
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem
          variant="destructive"
          disabled={!canStop}
          onSelect={() => stopRequest && onStop?.(stopRequest, false)}
        >
          {translate('auto.components.right.sidebar.ServiceRow.d3775acb14', 'Stop Service')}
        </ContextMenuItem>
        {canTellAgent && (
          <ContextMenuItem
            variant="destructive"
            onSelect={() => stopRequest && onStop?.(stopRequest, true)}
          >
            {translate(
              'auto.components.right.sidebar.ServiceRow.650664d898',
              'Stop and tell {{value0}}',
              { value0: service.launchedByAgent }
            )}
          </ContextMenuItem>
        )}
      </ContextMenuContent>
    </ContextMenu>
  )
}
