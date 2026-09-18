import React from 'react'
import { X } from 'lucide-react'
import { useAppStore } from '@/store'
import { Button } from '@/components/ui/button'
import { getAgentCatalog } from '@/lib/agent-catalog'
import { translate } from '@/i18n/i18n'
import { getSidebarAgentVisibilityLabel } from './workspace-agent-scope'

/** Shown only when the sidebar is scoped to a subset of catalog agents. */
const SidebarAgentScopeStrip = React.memo(function SidebarAgentScopeStrip() {
  const filterAgentIds = useAppStore((s) => s.filterAgentIds)
  const setFilterAgentIds = useAppStore((s) => s.setFilterAgentIds)

  if (!filterAgentIds) {
    return null
  }

  const catalog = getAgentCatalog()
  const label = getSidebarAgentVisibilityLabel(filterAgentIds, catalog)

  return (
    <div className="px-2 pb-1">
      <div className="flex h-7 w-full items-center justify-between gap-2 rounded-md border border-sidebar-border/70 bg-sidebar-accent/35 pl-2 pr-1">
        <span className="truncate text-xs font-medium text-sidebar-foreground">
          {translate(
            'auto.components.sidebar.SidebarAgentScopeStrip.scopedTo',
            '{{value0}} visible',
            {
              value0: label
            }
          )}
        </span>
        <Button
          variant="ghost"
          size="sm"
          className="h-5 shrink-0 gap-1 rounded px-1.5 text-[11px] font-normal text-muted-foreground hover:text-foreground"
          onClick={() => setFilterAgentIds(null)}
        >
          <X className="size-3" />
          {translate('auto.components.sidebar.SidebarAgentScopeStrip.backToAll', 'All agents')}
        </Button>
      </div>
    </div>
  )
})

export default SidebarAgentScopeStrip
