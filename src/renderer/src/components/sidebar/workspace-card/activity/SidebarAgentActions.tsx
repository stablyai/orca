import { closeSidebarAgent } from './sidebar-agent-close'
import { NativeChatCliForkMenuItems } from '@/components/tab-bar/NativeChatCliForkMenuItems'
import { SidebarAgentRenameDialog } from './SidebarAgentRenameDialog'
import { useState } from 'react'
import { MoreHorizontal, Pencil, SquareTerminal, X } from 'lucide-react'
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

export function SidebarAgentActions({
  agent,
  onActivate
}: {
  agent: DashboardAgentRow
  onActivate: (tabId: string, paneKey: string) => void
}): React.JSX.Element | null {
  const [open, setOpen] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const liveTab = useAppStore((state) =>
    state.unifiedTabsByWorktree[agent.tab.worktreeId]?.find(
      (tab) => tab.id === agent.tab.id || tab.entityId === agent.tab.id
    )
  )
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
      <DropdownMenu modal={false} open={open} onOpenChange={setOpen}>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="size-5"
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
          {liveTab ? (
            <DropdownMenuItem onSelect={() => setRenaming(true)}>
              <Pencil />
              {translate('sidebar.agentActions.rename', 'Rename…')}
            </DropdownMenuItem>
          ) : null}
          {liveTab?.contentType === 'agent-session' ? (
            <NativeChatCliForkMenuItems
              tab={{ id: liveTab.id, worktreeId: agent.tab.worktreeId }}
              nativeChat={{ sessionId: liveTab.entityId, agent: liveTab.agentSessionAgent }}
              leadingSeparator={false}
              menuKind="dropdown"
              onComplete={() => setOpen(false)}
            />
          ) : null}
          {liveTab?.contentType === 'terminal' && liveTab.viewMode === 'chat' ? (
            <DropdownMenuItem
              onSelect={() => {
                useAppStore.getState().setTabViewMode(liveTab.id, 'terminal')
                onActivate(agent.tab.id, agent.paneKey)
              }}
            >
              <SquareTerminal />
              {translate(
                'components.tab.bar.SortableTabContextMenu.switchToTerminalView',
                'Continue with Terminal Agent'
              )}
            </DropdownMenuItem>
          ) : null}
          {sessionId ? <NativeChatProviderSessionIdMenuItem sessionId={sessionId} /> : null}
          <DropdownMenuItem onSelect={() => closeSidebarAgent(agent)}>
            <X />
            {translate('sidebar.agentActions.close', 'Close agent')}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {renaming ? (
        <SidebarAgentRenameDialog agent={agent} onClose={() => setRenaming(false)} />
      ) : null}
    </span>
  )
}
