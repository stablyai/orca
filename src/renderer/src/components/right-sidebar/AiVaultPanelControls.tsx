import type React from 'react'
import { ChevronRight, Server } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { cn } from '@/lib/utils'
import type { AiVaultScope } from '../../../../shared/ai-vault-types'
import { getExecutionHostLabel, type ExecutionHostScope } from '../../../../shared/execution-host'
import type { AiVaultSessionGroup } from './ai-vault-session-filters'
import { translate } from '@/i18n/i18n'
import type { AiVaultHostScopeOption } from './ai-vault-host-scope'

export { VaultViewMenu } from './AiVaultViewMenu'

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
  hostOptions,
  onExecutionHostScopeChange
}: {
  executionHostScope: ExecutionHostScope
  hostOptions: readonly AiVaultHostScopeOption[]
  onExecutionHostScopeChange: (scope: ExecutionHostScope) => void
}): React.JSX.Element {
  const selectedOption = hostOptions.find((option) => option.id === executionHostScope)
  const label = selectedOption?.label ?? getExecutionHostLabel(executionHostScope)

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
          {hostOptions.map((option) => (
            <DropdownMenuRadioItem key={option.id} value={option.id}>
              {option.label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
