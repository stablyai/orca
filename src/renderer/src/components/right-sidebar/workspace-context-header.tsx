import type React from 'react'
import { RefreshCw, Server } from 'lucide-react'
import type { AgentContextReport } from '../../../../shared/agent-context'
import {
  getExecutionHostLabel,
  parseExecutionHostId,
  type ExecutionHostId
} from '../../../../shared/execution-host'
import type { PublicKnownRuntimeEnvironment } from '../../../../shared/runtime-environments'
import type { TuiAgent } from '../../../../shared/tui-agent'
import { Button } from '@/components/ui/button'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import { ContextScopeSwitch, ContextViewMenu } from './workspace-context-controls'
import type { ContextScopeFilter } from './workspace-context-model'
import {
  CONTEXT_SECTION_FILTERS,
  type ContextSectionFilter,
  type WorkspaceContextViewOptions
} from './workspace-context-view-options'

/**
 * Where the report was read, in the words Session History uses for the same
 * host: a runtime environment by its name, an SSH target by its id, this
 * client by platform — plus the WSL distro when the local read went there.
 */
export function workspaceContextHostLabel(args: {
  hostId: ExecutionHostId
  runtimeEnvironments: readonly Pick<PublicKnownRuntimeEnvironment, 'id' | 'name'>[]
  reportTarget: AgentContextReport['target'] | null
}): string {
  const parsed = parseExecutionHostId(args.hostId)
  if (parsed?.kind === 'runtime') {
    const environment = args.runtimeEnvironments.find((entry) => entry.id === parsed.environmentId)
    return environment?.name.trim() || getExecutionHostLabel(parsed.id)
  }
  const hostLabel = getExecutionHostLabel(args.hostId)
  if (args.reportTarget?.kind === 'wsl') {
    return translate(
      'auto.components.rightSidebar.WorkspaceContextPanel.hostWsl',
      '{{value0}} · WSL {{value1}}',
      { value0: hostLabel, value1: args.reportTarget.distro ?? '' }
    ).trim()
  }
  return hostLabel
}

function sectionFilterLabel(key: ContextSectionFilter): string {
  switch (key) {
    case 'all':
      return translate('auto.components.rightSidebar.WorkspaceContextPanel.filterAll', 'All')
    case 'instructions':
      return translate(
        'auto.components.rightSidebar.WorkspaceContextPanel.instructions',
        'Instructions'
      )
    case 'skills':
      return translate('auto.components.rightSidebar.WorkspaceContextPanel.skills', 'Skills')
    case 'mcp':
      return translate('auto.components.rightSidebar.WorkspaceContextPanel.filterMcp', 'MCP')
    case 'hooks':
      return translate('auto.components.rightSidebar.WorkspaceContextPanel.hooks', 'Hooks')
    default:
      return translate('auto.components.rightSidebar.WorkspaceContextPanel.plugins', 'Plugins')
  }
}

export function WorkspaceContextHeader({
  subtitle,
  hostLabel,
  loading,
  agentOptions,
  options,
  onScopeChange,
  onSectionChange,
  onAgentEnabledChange,
  onAllAgentsEnabledChange,
  onShowMissingChange,
  onReset,
  onRefresh
}: {
  subtitle: string
  hostLabel: string
  loading: boolean
  agentOptions: readonly TuiAgent[]
  options: WorkspaceContextViewOptions
  onScopeChange: (scope: ContextScopeFilter) => void
  onSectionChange: (section: ContextSectionFilter) => void
  onAgentEnabledChange: (agent: TuiAgent, enabled: boolean) => void
  onAllAgentsEnabledChange: (enabled: boolean) => void
  onShowMissingChange: (showMissing: boolean) => void
  onReset: () => void
  onRefresh: () => void
}): React.JSX.Element {
  const adjustmentCount =
    (options.disabledAgents.length > 0 ? 1 : 0) + (options.showMissing ? 1 : 0)
  return (
    <>
      <div className="flex items-start gap-2 border-b border-border px-4 py-3">
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium text-foreground">
            {translate('auto.components.rightSidebar.WorkspaceContextPanel.title', 'Agent context')}
          </div>
          <div className="mt-0.5 truncate text-xs text-muted-foreground">{subtitle}</div>
          <div
            className="mt-0.5 flex min-w-0 items-center gap-1 text-[11px] text-muted-foreground"
            title={translate(
              'auto.components.rightSidebar.WorkspaceContextPanel.hostTitle',
              'Read on the host that runs this workspace'
            )}
          >
            <Server className="size-3 shrink-0" />
            <span className="min-w-0 truncate">{hostLabel}</span>
          </div>
        </div>
        <ContextViewMenu
          agentOptions={agentOptions}
          disabledAgents={options.disabledAgents}
          showMissing={options.showMissing}
          adjustmentCount={adjustmentCount}
          onAgentEnabledChange={onAgentEnabledChange}
          onAllAgentsEnabledChange={onAllAgentsEnabledChange}
          onShowMissingChange={onShowMissingChange}
          onReset={onReset}
        />
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          onClick={onRefresh}
          aria-label={translate(
            'auto.components.rightSidebar.WorkspaceContextPanel.refresh',
            'Refresh'
          )}
          title={translate('auto.components.rightSidebar.WorkspaceContextPanel.refresh', 'Refresh')}
          className="text-muted-foreground hover:text-foreground"
        >
          <RefreshCw className={cn(loading && 'animate-spin')} />
        </Button>
      </div>
      <div className="border-b border-border px-3 py-1.5">
        <ContextScopeSwitch scope={options.scope} onScopeChange={onScopeChange} />
      </div>
      <ToggleGroup
        type="single"
        spacing={1}
        value={options.section}
        onValueChange={(value) => {
          if (value) {
            onSectionChange(value as ContextSectionFilter)
          }
        }}
        aria-label={translate(
          'auto.components.rightSidebar.WorkspaceContextPanel.filterLabel',
          'Filter sections'
        )}
        className="w-full flex-wrap justify-start rounded-none border-b border-border px-3 py-1.5"
      >
        {CONTEXT_SECTION_FILTERS.map((key) => (
          <ToggleGroupItem
            key={key}
            value={key}
            className="h-6 min-h-6 min-w-0 rounded-md border-0 px-2 text-[11px] font-normal text-muted-foreground shadow-none hover:bg-accent/60 hover:text-foreground data-[state=on]:bg-accent data-[state=on]:text-accent-foreground"
          >
            {sectionFilterLabel(key)}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
    </>
  )
}
