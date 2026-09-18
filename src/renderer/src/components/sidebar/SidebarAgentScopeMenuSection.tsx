import type React from 'react'
import { useMemo } from 'react'
import {
  DropdownMenuCheckboxItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger
} from '@/components/ui/dropdown-menu'
import { AgentIcon, getAgentCatalog } from '@/lib/agent-catalog'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import {
  toggleAllFilterAgents,
  toggleFilterAgentId
} from '../../../../shared/workspace-agent-filter'
import { getSidebarAgentVisibilityLabel } from './workspace-agent-scope'

type SidebarAgentScopeMenuSectionProps = {
  preserveWorkspaceBoardOpen: boolean
}

export function SidebarAgentScopeMenuSection({
  preserveWorkspaceBoardOpen
}: SidebarAgentScopeMenuSectionProps): React.JSX.Element {
  const filterAgentIds = useAppStore((s) => s.filterAgentIds)
  const setFilterAgentIds = useAppStore((s) => s.setFilterAgentIds)
  const agents = getAgentCatalog()
  const catalogIds = useMemo(() => agents.map((agent) => agent.id), [agents])
  const allVisible = filterAgentIds == null
  const selectedIds = new Set(filterAgentIds ?? [])
  const visibilityLabel = getSidebarAgentVisibilityLabel(filterAgentIds, agents)

  // Why: one Sort-by-style row like Hosts — nested panel holds the multi-select
  // so the parent menu stays a flat list of single rows.
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger>
        <span className="flex flex-1 items-center justify-between gap-3">
          <span>
            {translate('auto.components.sidebar.SidebarWorkspaceOptionsMenu.agents', 'Agent')}
          </span>
          <span className="min-w-0 truncate text-[11px] font-medium text-muted-foreground">
            {visibilityLabel}
          </span>
        </span>
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent
        // Why: Host keeps checkbox items as direct SubContent children so
        // Radix does not dismiss the submenu. Scroll the menu itself.
        className="w-56 max-h-64 overflow-y-auto scrollbar-sleek"
        data-workspace-board-preserve-open={preserveWorkspaceBoardOpen ? '' : undefined}
      >
        <DropdownMenuCheckboxItem
          checked={allVisible}
          onCheckedChange={() =>
            setFilterAgentIds(toggleAllFilterAgents(filterAgentIds, catalogIds))
          }
          onSelect={(e) => e.preventDefault()}
          className="min-h-11 items-start py-1.5"
        >
          <span className="flex min-w-0 flex-col gap-0.5">
            <span className="truncate">
              {translate('auto.components.sidebar.sidebarAgentOptions.allAgents', 'All agents')}
            </span>
            <span className="truncate text-[11px] font-normal text-muted-foreground">
              {translate(
                'auto.components.sidebar.SidebarWorkspaceOptionsMenu.allAgentsDetail',
                'Show every agent'
              )}
            </span>
          </span>
        </DropdownMenuCheckboxItem>
        {agents.map((agent) => (
          <DropdownMenuCheckboxItem
            key={agent.id}
            checked={selectedIds.has(agent.id)}
            disabled={!allVisible && selectedIds.has(agent.id) && selectedIds.size <= 1}
            onCheckedChange={() =>
              setFilterAgentIds(toggleFilterAgentId(filterAgentIds, agent.id, catalogIds))
            }
            onSelect={(e) => e.preventDefault()}
            className="min-h-11 items-start py-1.5"
          >
            <span className="flex min-w-0 items-center gap-2">
              <AgentIcon agent={agent.id} size={13} />
              <span className="truncate">{agent.label}</span>
            </span>
          </DropdownMenuCheckboxItem>
        ))}
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  )
}
