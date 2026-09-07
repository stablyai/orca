import {
  DropdownMenuCheckboxItem,
  DropdownMenuLabel,
  DropdownMenuSeparator
} from '@/components/ui/dropdown-menu'
import { translate } from '@/i18n/i18n'
import { FilterOptionCount } from './FilterOptionCount'

type AgentMapContentFilterItemsProps = {
  showAgentlessWorkspaces: boolean
  agentlessWorkspaceCount: number
  onShowAgentlessWorkspacesChange: (show: boolean) => void
  showOrchestrationLinks: boolean
  onShowOrchestrationLinksChange: (show: boolean) => void
}

/**
 * The map-only "Map content" rows of the shared dashboard filter menu. These
 * govern what the map draws rather than which cards survive filtering, so they
 * sit apart from the project/status/review sections.
 */
export function AgentMapContentFilterItems({
  showAgentlessWorkspaces,
  agentlessWorkspaceCount,
  onShowAgentlessWorkspacesChange,
  showOrchestrationLinks,
  onShowOrchestrationLinksChange
}: AgentMapContentFilterItemsProps): React.JSX.Element {
  return (
    <>
      <DropdownMenuLabel>
        {translate('dashboardPopout.map.filters.workspaceVisibility', 'Map content')}
      </DropdownMenuLabel>
      <DropdownMenuCheckboxItem
        checked={showAgentlessWorkspaces}
        onCheckedChange={(checked) => onShowAgentlessWorkspacesChange(checked === true)}
        onSelect={(event) => event.preventDefault()}
      >
        <span className="truncate">
          {translate(
            'dashboardPopout.map.filters.agentlessWorkspaces',
            'Workspaces without agents'
          )}
        </span>
        <FilterOptionCount count={agentlessWorkspaceCount} />
      </DropdownMenuCheckboxItem>
      <DropdownMenuCheckboxItem
        checked={showOrchestrationLinks}
        onCheckedChange={(checked) => onShowOrchestrationLinksChange(checked === true)}
        onSelect={(event) => event.preventDefault()}
      >
        <span className="truncate">
          {translate('dashboardPopout.map.filters.orchestrationLinks', 'Orchestration links')}
        </span>
      </DropdownMenuCheckboxItem>
      <DropdownMenuSeparator />
    </>
  )
}
