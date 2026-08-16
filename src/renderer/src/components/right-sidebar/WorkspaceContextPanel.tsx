import React, { useCallback, useMemo, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import type { AgentContextInstructionFile } from '../../../../shared/agent-context'
import { detectLanguage } from '@/lib/language-detect'
import { joinPath } from '@/lib/path'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { AGENT_CATALOG } from '@/lib/agent-catalog'
import type { TuiAgent } from '../../../../shared/tui-agent'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { useActiveWorktree } from '@/store/selectors'
import { useWorkspaceAgentContext } from './use-workspace-agent-context'
import {
  agentsInContext,
  countPresent,
  filterReportByAgents,
  filterReportByScope,
  formatBytes,
  groupInstructionFiles,
  groupSkillsBySource,
  isPathInside,
  selectSkillsForAgents,
  selectSkillsForScope,
  selectWorkspaceSkills,
  type ContextScopeFilter
} from './workspace-context-model'
import { ContextScopeSwitch, ContextViewMenu } from './workspace-context-controls'
import { ContextRow, ContextSection, EmptyRow, scopeLabel } from './workspace-context-rows'
import { HookFilesBody, McpFilesBody, PluginsBody } from './workspace-context-sections'

type SectionKey = 'instructions' | 'skills' | 'mcp' | 'hooks' | 'plugins'
type SectionFilter = SectionKey | 'all'
const SECTION_FILTERS: SectionFilter[] = [
  'all',
  'instructions',
  'skills',
  'mcp',
  'hooks',
  'plugins'
]

const DEFAULT_OPEN: Record<SectionKey, boolean> = {
  instructions: true,
  skills: true,
  mcp: true,
  hooks: false,
  plugins: false
}

function relativeToWorkspace(pathValue: string, workspaceCwd: string): string {
  const normalized = pathValue.replace(/\\/g, '/')
  const base = workspaceCwd.replace(/\\/g, '/').replace(/\/+$/, '')
  return normalized.slice(base.length + 1)
}

function sectionFilterLabel(key: SectionFilter): string {
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

export default function WorkspaceContextPanel(): React.JSX.Element {
  const worktree = useActiveWorktree()
  const openFile = useAppStore((s) => s.openFile)
  const {
    report: fullReport,
    loading,
    error,
    skills,
    skillSources,
    skillsLoading,
    refresh
  } = useWorkspaceAgentContext()
  // Why: `null` means every agent present — the default survives a rescan
  // that adds an agent, where an explicit list would silently hide it.
  const [agentFilter, setAgentFilter] = useState<TuiAgent[] | null>(null)
  const [scope, setScope] = useState<ContextScopeFilter>('all')
  const [showMissing, setShowMissing] = useState(false)
  const report = useMemo(
    () => filterReportByScope(filterReportByAgents(fullReport, agentFilter), scope),
    [fullReport, agentFilter, scope]
  )
  const [filter, setFilter] = useState<SectionFilter>('all')
  const showSection = (key: SectionKey): boolean => filter === 'all' || filter === key
  const [open, setOpen] = useState<Record<SectionKey, boolean>>(DEFAULT_OPEN)
  const toggle = useCallback(
    (key: SectionKey) => setOpen((current) => ({ ...current, [key]: !current[key] })),
    []
  )

  const workspaceCwd = report?.target.cwd ?? null
  const workspaceSkills = useMemo(
    () =>
      selectSkillsForScope(
        selectSkillsForAgents(
          selectWorkspaceSkills(skills, workspaceCwd),
          skillSources,
          agentFilter
        ),
        scope
      ),
    [agentFilter, scope, skillSources, skills, workspaceCwd]
  )
  const agentOptions = useMemo(() => {
    const present = new Set(
      agentsInContext(fullReport, selectWorkspaceSkills(skills, workspaceCwd), skillSources)
    )
    return AGENT_CATALOG.filter((entry) => present.has(entry.id)).map((entry) => entry.id)
  }, [fullReport, skillSources, skills, workspaceCwd])
  const setAgentEnabled = useCallback(
    (agent: TuiAgent, enabled: boolean) =>
      setAgentFilter((current) => {
        const base = current ?? agentOptions
        return enabled ? [...new Set([...base, agent])] : base.filter((entry) => entry !== agent)
      }),
    [agentOptions]
  )
  const adjustmentCount = (agentFilter ? 1 : 0) + (showMissing ? 1 : 0)
  const counts = countPresent(report)
  const skillGroups = useMemo(() => groupSkillsBySource(workspaceSkills), [workspaceSkills])
  const instructionGroups = useMemo(
    () => groupInstructionFiles(report?.instructionFiles ?? [], showMissing),
    [report, showMissing]
  )

  const openInstructionFile = useCallback(
    (file: AgentContextInstructionFile) => {
      if (!worktree || !workspaceCwd || !file.exists || file.entryCount !== undefined) {
        return
      }
      if (!isPathInside(file.path, workspaceCwd)) {
        return
      }
      const relativePath = relativeToWorkspace(file.path, workspaceCwd)
      openFile({
        filePath: joinPath(worktree.path, relativePath),
        relativePath,
        worktreeId: worktree.id,
        language: detectLanguage(relativePath),
        mode: 'edit'
      })
    },
    [openFile, workspaceCwd, worktree]
  )

  if (!worktree) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center p-6 text-center text-sm text-muted-foreground">
        {translate(
          'auto.components.rightSidebar.WorkspaceContextPanel.noWorkspace',
          'Select a workspace to see the context its agents load.'
        )}
      </div>
    )
  }

  const hostLabel =
    report?.target.kind === 'wsl'
      ? `WSL · ${report.target.distro ?? ''}`
      : report
        ? translate('auto.components.rightSidebar.WorkspaceContextPanel.hostLocal', 'This host')
        : ''

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-background">
      <div className="flex items-start gap-2 border-b border-border px-4 py-3">
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium text-foreground">
            {translate('auto.components.rightSidebar.WorkspaceContextPanel.title', 'Agent context')}
          </div>
          <div className="mt-0.5 truncate text-xs text-muted-foreground">
            {worktree.branch.replace(/^refs\/heads\//, '') || worktree.path}
            {hostLabel ? ` · ${hostLabel}` : ''}
          </div>
        </div>
        <ContextViewMenu
          agentOptions={agentOptions}
          agents={agentFilter}
          showMissing={showMissing}
          adjustmentCount={adjustmentCount}
          onAgentEnabledChange={setAgentEnabled}
          onAllAgentsEnabledChange={(enabled) => setAgentFilter(enabled ? null : [])}
          onShowMissingChange={setShowMissing}
          onReset={() => {
            setAgentFilter(null)
            setShowMissing(false)
          }}
        />
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          onClick={refresh}
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
        <ContextScopeSwitch scope={scope} onScopeChange={setScope} />
      </div>
      <ToggleGroup
        type="single"
        spacing={1}
        value={filter}
        onValueChange={(value) => {
          if (value) {
            setFilter(value as SectionFilter)
          }
        }}
        aria-label={translate(
          'auto.components.rightSidebar.WorkspaceContextPanel.filterLabel',
          'Filter sections'
        )}
        className="w-full flex-wrap justify-start rounded-none border-b border-border px-3 py-1.5"
      >
        {SECTION_FILTERS.map((key) => (
          <ToggleGroupItem
            key={key}
            value={key}
            className="h-6 min-h-6 min-w-0 rounded-md border-0 px-2 text-[11px] font-normal text-muted-foreground shadow-none hover:bg-accent/60 hover:text-foreground data-[state=on]:bg-accent data-[state=on]:text-accent-foreground"
          >
            {sectionFilterLabel(key)}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
      {error ? (
        <div className="border-b border-border px-4 py-2 text-xs text-destructive">{error}</div>
      ) : null}
      <div className="scrollbar-sleek min-h-0 flex-1 overflow-y-auto overflow-x-hidden">
        {showSection('instructions') && (
          <ContextSection
            title={translate(
              'auto.components.rightSidebar.WorkspaceContextPanel.instructions',
              'Instructions'
            )}
            count={report ? counts.instructionFiles : null}
            open={filter === 'instructions' || open.instructions}
            onToggle={() => toggle('instructions')}
          >
            {report && instructionGroups.length === 0 ? (
              <EmptyRow
                text={translate(
                  'auto.components.rightSidebar.WorkspaceContextPanel.noInstructions',
                  'No instruction files found for this workspace.'
                )}
              />
            ) : (
              instructionGroups.map((group) => (
                <div key={group.scope}>
                  <div className="px-3 pt-1 text-[10px] uppercase tracking-wide text-muted-foreground">
                    {scopeLabel(group.scope)}
                  </div>
                  {group.files.map((file) => (
                    <ContextRow
                      key={file.id}
                      primary={file.label}
                      secondary={file.path}
                      meta={
                        file.entryCount !== undefined
                          ? translate(
                              'auto.components.rightSidebar.WorkspaceContextPanel.ruleCount',
                              '{{value0}} rules',
                              { value0: file.entryCount }
                            )
                          : file.exists
                            ? formatBytes(file.sizeBytes)
                            : translate(
                                'auto.components.rightSidebar.WorkspaceContextPanel.missing',
                                'not found'
                              )
                      }
                      agents={file.agents}
                      muted={!file.exists}
                      onClick={
                        file.exists && file.scope === 'project' && file.entryCount === undefined
                          ? () => openInstructionFile(file)
                          : undefined
                      }
                      title={file.path}
                    />
                  ))}
                </div>
              ))
            )}
          </ContextSection>
        )}

        {showSection('skills') && (
          <ContextSection
            title={translate('auto.components.rightSidebar.WorkspaceContextPanel.skills', 'Skills')}
            count={skillsLoading && workspaceSkills.length === 0 ? null : workspaceSkills.length}
            open={filter === 'skills' || open.skills}
            onToggle={() => toggle('skills')}
          >
            {workspaceSkills.length === 0 ? (
              <EmptyRow
                text={
                  skillsLoading
                    ? translate(
                        'auto.components.rightSidebar.WorkspaceContextPanel.scanning',
                        'Scanning…'
                      )
                    : translate(
                        'auto.components.rightSidebar.WorkspaceContextPanel.noSkills',
                        'No skills discovered.'
                      )
                }
              />
            ) : (
              skillGroups.map((group) => (
                <div key={group.label}>
                  <div className="flex items-baseline px-3 pt-1 text-[10px] uppercase tracking-wide text-muted-foreground">
                    <span className="min-w-0 flex-1 truncate">{group.label}</span>
                    <span className="tabular-nums">{group.skills.length}</span>
                  </div>
                  {group.skills.map((skill) => (
                    <ContextRow
                      key={skill.id}
                      primary={skill.name}
                      secondary={skill.skillFilePath}
                      agents={skill.providers.filter((provider) => provider !== 'agent-skills')}
                      title={skill.description ?? skill.skillFilePath}
                    />
                  ))}
                </div>
              ))
            )}
          </ContextSection>
        )}

        {showSection('mcp') && (
          <ContextSection
            title={translate(
              'auto.components.rightSidebar.WorkspaceContextPanel.mcp',
              'MCP servers'
            )}
            count={report ? counts.mcpServers : null}
            open={filter === 'mcp' || open.mcp}
            onToggle={() => toggle('mcp')}
          >
            <McpFilesBody report={report} showMissing={showMissing} />
          </ContextSection>
        )}

        {showSection('hooks') && (
          <ContextSection
            title={translate('auto.components.rightSidebar.WorkspaceContextPanel.hooks', 'Hooks')}
            count={report ? counts.hooks : null}
            open={filter === 'hooks' || open.hooks}
            onToggle={() => toggle('hooks')}
          >
            <HookFilesBody report={report} showMissing={showMissing} />
          </ContextSection>
        )}

        {showSection('plugins') && (
          <ContextSection
            title={translate(
              'auto.components.rightSidebar.WorkspaceContextPanel.plugins',
              'Plugins'
            )}
            count={report ? counts.plugins : null}
            open={filter === 'plugins' || open.plugins}
            onToggle={() => toggle('plugins')}
          >
            <PluginsBody report={report} showMissing={showMissing} />
          </ContextSection>
        )}
      </div>
    </div>
  )
}
