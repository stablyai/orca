import type React from 'react'
import { ListFilter } from 'lucide-react'
import type { TuiAgent } from '../../../../shared/tui-agent'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { AgentIcon, getAgentLabel } from '@/lib/agent-catalog'
import { translate } from '@/i18n/i18n'
import {
  SIDEBAR_AGENT_BULK_ACTION_CLASS,
  SIDEBAR_SCOPE_TOGGLE_GROUP_CLASS,
  SIDEBAR_SCOPE_TOGGLE_ITEM_CLASS
} from './sidebar-scope-toggle'
import type { ContextScopeFilter } from './workspace-context-model'

/** Workspace / User / All — the same segmented switch Session History uses for its scope. */
export function ContextScopeSwitch({
  scope,
  onScopeChange
}: {
  scope: ContextScopeFilter
  onScopeChange: (scope: ContextScopeFilter) => void
}): React.JSX.Element {
  return (
    <ToggleGroup
      type="single"
      value={scope}
      onValueChange={(value) => {
        if (value === 'workspace' || value === 'user' || value === 'all') {
          onScopeChange(value)
        }
      }}
      variant="outline"
      className={SIDEBAR_SCOPE_TOGGLE_GROUP_CLASS}
      aria-label={translate(
        'auto.components.rightSidebar.WorkspaceContextPanel.scopeAriaLabel',
        'Agent context scope'
      )}
    >
      <ToggleGroupItem value="workspace" className={SIDEBAR_SCOPE_TOGGLE_ITEM_CLASS}>
        {translate('auto.components.rightSidebar.WorkspaceContextPanel.scopeProject', 'Workspace')}
      </ToggleGroupItem>
      <ToggleGroupItem value="user" className={SIDEBAR_SCOPE_TOGGLE_ITEM_CLASS}>
        {translate('auto.components.rightSidebar.WorkspaceContextPanel.scopeHome', 'User')}
      </ToggleGroupItem>
      <ToggleGroupItem value="all" className={SIDEBAR_SCOPE_TOGGLE_ITEM_CLASS}>
        {translate('auto.components.rightSidebar.WorkspaceContextPanel.filterAll', 'All')}
      </ToggleGroupItem>
    </ToggleGroup>
  )
}

/**
 * View options — which agents' context to show plus the empty-location toggle.
 * The list only offers agents that actually read something in this workspace;
 * agents are tracked as the disabled set so a newly found agent shows up on.
 */
export function ContextViewMenu({
  agentOptions,
  disabledAgents,
  showMissing,
  adjustmentCount,
  onAgentEnabledChange,
  onAllAgentsEnabledChange,
  onShowMissingChange,
  onReset
}: {
  agentOptions: readonly TuiAgent[]
  disabledAgents: readonly TuiAgent[]
  showMissing: boolean
  adjustmentCount: number
  onAgentEnabledChange: (agent: TuiAgent, enabled: boolean) => void
  onAllAgentsEnabledChange: (enabled: boolean) => void
  onShowMissingChange: (showMissing: boolean) => void
  onReset: () => void
}): React.JSX.Element {
  const isEnabled = (agent: TuiAgent): boolean => !disabledAgents.includes(agent)
  const allSelected = agentOptions.every(isEnabled)
  const noneSelected = agentOptions.length > 0 && !agentOptions.some(isEnabled)
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          className="relative text-muted-foreground hover:text-foreground"
          aria-label={translate(
            'auto.components.rightSidebar.WorkspaceContextPanel.viewOptions',
            'Agent context view options'
          )}
        >
          <ListFilter className="size-3" />
          {adjustmentCount > 0 ? (
            <span
              aria-hidden
              className="absolute -right-1 -top-1 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-primary px-1 text-[9px] font-medium leading-none text-primary-foreground"
            >
              {adjustmentCount}
            </span>
          ) : null}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" sideOffset={6} className="w-56">
        <div className="flex items-center justify-between px-2 py-1">
          <span className="text-[11px] font-semibold text-muted-foreground">
            {translate('auto.components.rightSidebar.WorkspaceContextPanel.agents', 'Agents')}
          </span>
          {/* Why: real menu items so arrow keys reach them; preventDefault keeps the menu open. */}
          <div className="flex items-center gap-1">
            <DropdownMenuItem
              disabled={allSelected}
              onSelect={(event) => {
                event.preventDefault()
                onAllAgentsEnabledChange(true)
              }}
              className={SIDEBAR_AGENT_BULK_ACTION_CLASS}
            >
              {translate(
                'auto.components.rightSidebar.WorkspaceContextPanel.selectAllAgents',
                'Select all'
              )}
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={noneSelected}
              onSelect={(event) => {
                event.preventDefault()
                onAllAgentsEnabledChange(false)
              }}
              className={SIDEBAR_AGENT_BULK_ACTION_CLASS}
            >
              {translate('auto.components.rightSidebar.WorkspaceContextPanel.clearAgents', 'Clear')}
            </DropdownMenuItem>
          </div>
        </div>
        {agentOptions.map((agent) => (
          <DropdownMenuCheckboxItem
            key={agent}
            checked={isEnabled(agent)}
            onCheckedChange={(checked) => onAgentEnabledChange(agent, checked === true)}
            onSelect={(event) => event.preventDefault()}
          >
            <AgentIcon agent={agent} size={14} />
            {getAgentLabel(agent)}
          </DropdownMenuCheckboxItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuCheckboxItem
          checked={showMissing}
          onCheckedChange={(checked) => onShowMissingChange(checked === true)}
          onSelect={(event) => event.preventDefault()}
        >
          {translate(
            'auto.components.rightSidebar.WorkspaceContextPanel.showMissing',
            'Show locations that were checked but empty'
          )}
        </DropdownMenuCheckboxItem>
        {adjustmentCount > 0 ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={onReset}>
              {translate(
                'auto.components.rightSidebar.WorkspaceContextPanel.resetView',
                'Reset view'
              )}
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
