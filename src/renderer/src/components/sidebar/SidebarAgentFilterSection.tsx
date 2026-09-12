import React, { useMemo } from 'react'
import { DropdownMenuCheckboxItem } from '@/components/ui/dropdown-menu'
import { useAppStore } from '@/store'
import { AgentIcon, getAgentCatalog } from '@/lib/agent-catalog'
import { translate } from '@/i18n/i18n'
import {
  toggleAllFilterAgents,
  toggleFilterAgentId
} from '../../../../shared/workspace-agent-filter'

const SidebarAgentFilterSection = React.memo(function SidebarAgentFilterSection() {
  const filterAgentIds = useAppStore((s) => s.filterAgentIds)
  const setFilterAgentIds = useAppStore((s) => s.setFilterAgentIds)
  const agents = getAgentCatalog()
  const catalogIds = useMemo(() => agents.map((agent) => agent.id), [agents])
  const allVisible = filterAgentIds == null
  const selectedIds = new Set(filterAgentIds ?? [])

  return (
    <div
      role="group"
      aria-label={translate('auto.components.sidebar.SidebarAgentFilterSection.agent', 'Agent')}
    >
      <div className="flex items-center justify-between px-2 py-1">
        <span className="text-[11px] font-semibold tracking-wide uppercase text-muted-foreground">
          {translate('auto.components.sidebar.SidebarAgentFilterSection.agent', 'Agent')}
        </span>
      </div>
      <DropdownMenuCheckboxItem
        checked={allVisible}
        onCheckedChange={() => setFilterAgentIds(toggleAllFilterAgents(filterAgentIds, catalogIds))}
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
      <div className="max-h-64 overflow-y-auto scrollbar-sleek">
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
      </div>
    </div>
  )
})

export default SidebarAgentFilterSection
