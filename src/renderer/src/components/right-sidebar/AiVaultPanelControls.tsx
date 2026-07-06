import type React from 'react'
import {
  ArchiveRestore,
  Calendar,
  ChevronRight,
  Clock3,
  FolderOpen,
  ListFilter,
  LoaderCircle,
  PanelsTopLeft,
  Server
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { AgentIcon } from '@/lib/agent-catalog'
import { cn } from '@/lib/utils'
import {
  AI_VAULT_AGENTS,
  type AiVaultAgent,
  type AiVaultGroup,
  type AiVaultScope,
  type AiVaultSort
} from '../../../../shared/ai-vault-types'
import {
  ALL_EXECUTION_HOSTS_SCOPE,
  getExecutionHostLabel,
  LOCAL_EXECUTION_HOST_ID,
  type ExecutionHostScope
} from '../../../../shared/execution-host'
import { agentLabel, type AiVaultSessionGroup } from './ai-vault-session-filters'
import { translate } from '@/i18n/i18n'

const VAULT_HEADER_CONTROL_CLASS = 'size-6 shrink-0'

// Why: match ToggleGroup's spacing+outline qualifiers so selected edges out-specify its border-l-0 collapse.
const VAULT_SCOPE_SELECTED_EDGE_CLASS =
  'data-[spacing=0]:data-[variant=outline]:aria-[checked=true]:border-l data-[spacing=0]:data-[variant=outline]:data-[state=on]:border-l'

const VAULT_SCOPE_TOGGLE_ITEM_CLASS = `h-7 min-h-7 min-w-0 flex-1 basis-0 shrink border border-transparent bg-transparent px-2.5 text-[11px] font-medium leading-none text-foreground shadow-none hover:bg-sidebar-accent hover:text-sidebar-accent-foreground aria-[checked=true]:border-foreground/20 aria-[checked=true]:bg-foreground/10 aria-[checked=true]:text-foreground aria-[checked=true]:shadow-xs aria-[checked=true]:hover:bg-foreground/15 aria-[checked=true]:hover:text-foreground data-[state=on]:border-foreground/20 data-[state=on]:bg-foreground/10 data-[state=on]:text-foreground data-[state=on]:shadow-xs data-[state=on]:hover:bg-foreground/15 data-[state=on]:hover:text-foreground ${VAULT_SCOPE_SELECTED_EDGE_CLASS} @max-[300px]/ai-vault:px-1.5`

export function VaultGroupHeader({
  group,
  collapsed,
  onToggle
}: {
  group: AiVaultSessionGroup
  collapsed: boolean
  onToggle: () => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      className="flex h-8 w-full items-center gap-2 border-y border-sidebar-border bg-sidebar-accent/60 px-3 text-left text-xs font-semibold text-foreground transition-colors hover:bg-sidebar-accent"
      onClick={onToggle}
      aria-expanded={!collapsed}
    >
      <ChevronRight
        className={cn(
          'size-3.5 shrink-0 text-foreground/80 transition-transform',
          !collapsed && 'rotate-90'
        )}
      />
      <span className="min-w-0 flex-1 truncate">{group.label}</span>
      <span className="rounded-md border border-sidebar-border bg-background px-2 py-0.5 text-[11px] font-semibold tabular-nums leading-none text-foreground shadow-xs">
        {group.sessions.length}
      </span>
    </button>
  )
}

export function SessionLoadingState(): React.JSX.Element {
  return (
    <div className="px-3 py-3" aria-busy="true">
      <div className="mb-3 flex items-center gap-2 text-[11px] text-muted-foreground">
        <LoaderCircle className="size-3.5 shrink-0 animate-spin" />
        <span>
          {translate(
            'auto.components.right.sidebar.AiVaultPanelControls.scanningSessions',
            'Scanning sessions'
          )}
        </span>
      </div>
      <div className="space-y-3">
        {Array.from({ length: 6 }, (_, index) => (
          <div key={index} className="flex items-start gap-2">
            <div className="mt-1 size-4 rounded-full bg-sidebar-accent" />
            <div className="min-w-0 flex-1 space-y-1.5">
              <div className="h-3 w-4/5 rounded-sm bg-sidebar-accent" />
              <div className="h-2.5 w-3/5 rounded-sm bg-sidebar-accent/75" />
              <div className="h-2.5 w-2/5 rounded-sm bg-sidebar-accent/60" />
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

export function VaultScopeSwitch({
  scope,
  workspaceAvailable,
  projectAvailable,
  onScopeChange
}: {
  scope: AiVaultScope
  workspaceAvailable: boolean
  projectAvailable: boolean
  onScopeChange: (scope: AiVaultScope) => void
}): React.JSX.Element {
  const workspaceLabel = translate(
    'auto.components.right.sidebar.AiVaultPanelControls.workspaceScope',
    'Workspace'
  )
  const projectLabel = translate(
    'auto.components.right.sidebar.AiVaultPanelControls.projectScope',
    'Project'
  )
  const allLabel = translate('auto.components.right.sidebar.AiVaultPanelControls.allScope', 'All')

  return (
    <ToggleGroup
      type="single"
      value={scope}
      onValueChange={(value) => {
        if (value === 'workspace' || value === 'project' || value === 'all') {
          onScopeChange(value)
        }
      }}
      variant="outline"
      className="h-7 w-full rounded-md border border-sidebar-border bg-sidebar-accent/35 shadow-xs"
      aria-label={translate(
        'auto.components.right.sidebar.AiVaultPanelControls.scopeAriaLabel',
        'Session History scope: {{value0}}',
        {
          value0:
            scope === 'workspace'
              ? translate(
                  'auto.components.right.sidebar.AiVaultPanelControls.currentWorkspaceLower',
                  'current workspace'
                )
              : scope === 'project'
                ? translate(
                    'auto.components.right.sidebar.AiVaultPanelControls.currentProjectLower',
                    'current project'
                  )
                : translate(
                    'auto.components.right.sidebar.AiVaultPanelControls.allSessionsLower',
                    'all sessions'
                  )
        }
      )}
    >
      <ToggleGroupItem
        value="workspace"
        disabled={!workspaceAvailable}
        className={VAULT_SCOPE_TOGGLE_ITEM_CLASS}
      >
        {workspaceLabel}
      </ToggleGroupItem>
      <ToggleGroupItem
        value="project"
        disabled={!projectAvailable}
        className={VAULT_SCOPE_TOGGLE_ITEM_CLASS}
      >
        {projectLabel}
      </ToggleGroupItem>
      <ToggleGroupItem value="all" className={VAULT_SCOPE_TOGGLE_ITEM_CLASS}>
        {allLabel}
      </ToggleGroupItem>
    </ToggleGroup>
  )
}

export function VaultHostScopeMenu({
  executionHostScope,
  activeSshExecutionHostScope,
  onExecutionHostScopeChange
}: {
  executionHostScope: ExecutionHostScope
  activeSshExecutionHostScope: ExecutionHostScope | null
  onExecutionHostScopeChange: (scope: ExecutionHostScope) => void
}): React.JSX.Element {
  const hostOptions = [
    LOCAL_EXECUTION_HOST_ID,
    ...(activeSshExecutionHostScope ? [activeSshExecutionHostScope] : []),
    ALL_EXECUTION_HOSTS_SCOPE
  ] as const
  const label = getExecutionHostLabel(executionHostScope)

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-6 max-w-24 shrink-0 gap-1 px-1.5 text-[11px] font-medium text-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground @max-[340px]/ai-vault:w-6 @max-[340px]/ai-vault:px-0"
          aria-label={translate(
            'auto.components.right.sidebar.AiVaultPanelControls.hostScopeAriaLabel',
            'Session History host: {{value0}}',
            { value0: label }
          )}
        >
          <Server className="size-3 shrink-0" />
          <span className="min-w-0 truncate @max-[340px]/ai-vault:hidden">{label}</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" sideOffset={6} className="w-44">
        <DropdownMenuLabel>
          {translate('auto.components.right.sidebar.AiVaultPanelControls.host', 'Host')}
        </DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={executionHostScope}
          onValueChange={(value) => onExecutionHostScopeChange(value as ExecutionHostScope)}
        >
          {hostOptions.map((scope) => (
            <DropdownMenuRadioItem key={scope} value={scope}>
              {getExecutionHostLabel(scope)}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export function VaultViewMenu({
  agents,
  sort,
  group,
  hideEmptySessions,
  adjustmentCount,
  onAgentEnabledChange,
  onSortChange,
  onGroupChange,
  onHideEmptySessionsChange,
  onReset
}: {
  agents: readonly AiVaultAgent[]
  sort: AiVaultSort
  group: AiVaultGroup
  hideEmptySessions: boolean
  adjustmentCount: number
  onAgentEnabledChange: (agent: AiVaultAgent, enabled: boolean) => void
  onSortChange: (sort: AiVaultSort) => void
  onGroupChange: (group: AiVaultGroup) => void
  onHideEmptySessionsChange: (hideEmptySessions: boolean) => void
  onReset: () => void
}): React.JSX.Element {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          className={cn(
            VAULT_HEADER_CONTROL_CLASS,
            'relative text-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground'
          )}
          aria-label={translate(
            'auto.components.right.sidebar.AiVaultPanelControls.viewOptionsAriaLabel',
            'Session History view options'
          )}
        >
          <ListFilter className="size-3" />
          <span className="sr-only">
            {translate(
              'auto.components.right.sidebar.AiVaultPanelControls.viewOptions',
              'View options'
            )}
          </span>
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
        <DropdownMenuLabel>
          {translate('auto.components.right.sidebar.AiVaultPanelControls.agents', 'Agents')}
        </DropdownMenuLabel>
        {AI_VAULT_AGENTS.map((agent) => (
          <DropdownMenuCheckboxItem
            key={agent}
            checked={agents.includes(agent)}
            disabled={agents.length === 1 && agents.includes(agent)}
            onCheckedChange={(checked) => onAgentEnabledChange(agent, checked === true)}
            onSelect={(event) => event.preventDefault()}
          >
            <AgentIcon agent={agent} size={14} />
            {agentLabel(agent)}
          </DropdownMenuCheckboxItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuLabel>
          {translate('auto.components.right.sidebar.AiVaultPanelControls.sort', 'Sort')}
        </DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={sort}
          onValueChange={(value) => onSortChange(value as AiVaultSort)}
        >
          <DropdownMenuRadioItem value="updated">
            <Clock3 className="size-3.5" />
            {translate(
              'auto.components.right.sidebar.AiVaultPanelControls.lastUpdated',
              'Last updated'
            )}
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="created">
            <Calendar className="size-3.5" />
            {translate('auto.components.right.sidebar.AiVaultPanelControls.created', 'Created')}
          </DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuLabel>
          {translate('auto.components.right.sidebar.AiVaultPanelControls.group', 'Group')}
        </DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={group}
          onValueChange={(value) => onGroupChange(value as AiVaultGroup)}
        >
          <DropdownMenuRadioItem value="project">
            <PanelsTopLeft className="size-3.5" />
            {translate('auto.components.right.sidebar.AiVaultPanelControls.project', 'Project')}
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="folder">
            <FolderOpen className="size-3.5" />
            {translate('auto.components.right.sidebar.AiVaultPanelControls.folder', 'Folder')}
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="agent">
            <ArchiveRestore className="size-3.5" />
            {translate('auto.components.right.sidebar.AiVaultPanelControls.agent', 'Agent')}
          </DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuCheckboxItem
          checked={hideEmptySessions}
          onCheckedChange={(checked) => onHideEmptySessionsChange(checked === true)}
          onSelect={(event) => event.preventDefault()}
        >
          {translate(
            'auto.components.right.sidebar.AiVaultPanelControls.hideEmptySessions',
            'Hide empty sessions'
          )}
        </DropdownMenuCheckboxItem>
        {adjustmentCount > 0 ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={onReset}>
              {translate(
                'auto.components.right.sidebar.AiVaultPanelControls.resetView',
                'Reset view'
              )}
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export function EmptyState({ title }: { title: string }): React.JSX.Element {
  return (
    <div className="flex h-full flex-col items-center justify-center px-4 text-center text-muted-foreground">
      <ArchiveRestore className="mb-3 size-7 opacity-50" />
      <p className="text-sm font-medium">{title}</p>
    </div>
  )
}
