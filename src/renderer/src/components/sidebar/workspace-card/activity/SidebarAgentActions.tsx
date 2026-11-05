import { MoreHorizontal, X } from 'lucide-react'
import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { NativeChatProviderSessionIdMenuItem } from '@/components/native-chat/NativeChatProviderSessionIdMenuItem'
import type { DashboardAgentRow } from '@/components/dashboard/useDashboardData'
import { dispatchWorkspaceTabCommand } from '@/lib/workspace-tab-commands'
import { closeTerminalTab } from '@/components/terminal/terminal-tab-actions'
import { closeSidebarAgentPane } from './sidebar-agent-pane-close'
import { parsePaneKey } from '../../../../../../shared/workspace-layout/stable-pane-id'

export function closeSidebarAgent(agent: DashboardAgentRow): void {
  if (agent.rowSource === 'subagent') {
    return
  }
  const state = useAppStore.getState()
  const { worktreeId, id: tabId } = agent.tab
  const tab = state.unifiedTabsByWorktree[worktreeId]?.find(
    (candidate) => candidate.id === tabId || candidate.entityId === tabId
  )
  const terminalId = tab?.contentType === 'terminal' ? tab.entityId : tabId
  const layout = state.terminalLayoutsByTabId[terminalId]
  if (layout?.root?.type === 'split') {
    const pane = parsePaneKey(agent.paneKey)
    if (pane) {
      void closeSidebarAgentPane(worktreeId, terminalId, pane.leafId).then((handled) => {
        if (!handled) {
          toast.error(
            translate(
              'sidebar.agentActions.paneUnavailable',
              'This agent could not be closed. Try again.'
            )
          )
        }
      })
    }
    return
  }
  if (tab) {
    dispatchWorkspaceTabCommand({
      type: 'close',
      target: { kind: 'tab', worktreeId, tabId: tab.id }
    })
  } else if (state.tabsByWorktree[worktreeId]?.some((candidate) => candidate.id === tabId)) {
    closeTerminalTab(tabId)
  } else {
    state.dropAgentStatus(agent.paneKey)
    state.dismissRetainedAgent(agent.paneKey)
  }
}

export function SidebarAgentActions({
  agent
}: {
  agent: DashboardAgentRow
}): React.JSX.Element | null {
  if (agent.rowSource === 'subagent') {
    return null
  }
  const sessionId = agent.entry.providerSession?.id
  return (
    <span
      className="shrink-0"
      onClick={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
    >
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="size-5 opacity-0 group-hover/compact-agent-row:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100 [@media(hover:none)]:opacity-100"
            aria-label={translate('sidebar.agentActions.menu', 'Agent actions')}
          >
            <MoreHorizontal className="size-3.5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          onClick={(event) => event.stopPropagation()}
          onCloseAutoFocus={(event) => event.preventDefault()}
        >
          {sessionId ? <NativeChatProviderSessionIdMenuItem sessionId={sessionId} /> : null}
          <DropdownMenuItem onSelect={() => closeSidebarAgent(agent)}>
            <X />
            {translate('sidebar.agentActions.close', 'Close agent')}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </span>
  )
}
