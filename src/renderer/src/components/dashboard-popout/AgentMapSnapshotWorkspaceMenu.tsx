import { useEffect, useRef } from 'react'
import { Moon, Plus } from 'lucide-react'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger
} from '@/components/ui/context-menu'
import { translate } from '@/i18n/i18n'
import { AgentIcon, getAgentLabel } from '@/lib/agent-catalog'
import type {
  DashboardSleepWorkspaceArgs,
  DashboardSpawnAgentArgs
} from '../../../../shared/dashboard-snapshot'
import type { TuiAgent } from '../../../../shared/tui-agent'

export type AgentMapSnapshotWorkspaceMenuRequest = {
  id: number
  worktreeId: string
  worktreeName: string
  launchableAgents: readonly TuiAgent[]
  clientX: number
  clientY: number
}

type AgentMapSnapshotWorkspaceMenuProps = {
  request: AgentMapSnapshotWorkspaceMenuRequest
  onOpenChange?: (open: boolean) => void
  onSpawnAgent?: (args: DashboardSpawnAgentArgs) => void
  onSleepWorkspace?: (args: DashboardSleepWorkspaceArgs) => void
}

/**
 * The workspace right-click menu for surfaces without the app store — the
 * pop-out window. Its actions are relayed to the main renderer, so it offers
 * only what a snapshot can describe, not the full sidebar menu.
 */
export function AgentMapSnapshotWorkspaceMenu({
  request,
  onOpenChange,
  onSpawnAgent,
  onSleepWorkspace
}: AgentMapSnapshotWorkspaceMenuProps): React.JSX.Element {
  const triggerRef = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    triggerRef.current?.dispatchEvent(
      new MouseEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
        clientX: request.clientX,
        clientY: request.clientY,
        button: 2
      })
    )
  }, [request])

  return (
    <div className="pointer-events-none absolute inset-0">
      <ContextMenu onOpenChange={onOpenChange}>
        <ContextMenuTrigger asChild>
          <span ref={triggerRef} aria-hidden />
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuLabel className="truncate">{request.worktreeName}</ContextMenuLabel>
          {onSpawnAgent ? (
            <ContextMenuSub>
              <ContextMenuSubTrigger disabled={request.launchableAgents.length === 0}>
                <Plus className="size-3.5" />
                {translate('dashboardPopout.map.spawnAgent', 'Start a new agent')}
              </ContextMenuSubTrigger>
              <ContextMenuSubContent>
                {request.launchableAgents.map((agent) => (
                  <ContextMenuItem
                    key={agent}
                    onSelect={() => onSpawnAgent({ worktreeId: request.worktreeId, agent })}
                  >
                    <AgentIcon agent={agent} size={14} />
                    {getAgentLabel(agent)}
                  </ContextMenuItem>
                ))}
              </ContextMenuSubContent>
            </ContextMenuSub>
          ) : null}
          {onSpawnAgent && onSleepWorkspace ? <ContextMenuSeparator /> : null}
          {onSleepWorkspace ? (
            <ContextMenuItem onSelect={() => onSleepWorkspace({ worktreeId: request.worktreeId })}>
              <Moon className="size-3.5" />
              {translate('dashboardPopout.map.sleepWorkspace', 'Sleep')}
            </ContextMenuItem>
          ) : null}
        </ContextMenuContent>
      </ContextMenu>
    </div>
  )
}
