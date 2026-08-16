import React, { useCallback, useMemo, useState } from 'react'
import type { AgentContextInstructionFile } from '../../../../shared/agent-context'
import type { TuiAgent } from '../../../../shared/tui-agent'
import { detectLanguage } from '@/lib/language-detect'
import { joinPath } from '@/lib/path'
import { AGENT_CATALOG } from '@/lib/agent-catalog'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { useActiveWorktree } from '@/store/selectors'
import {
  useWorkspaceAgentContext,
  type WorkspaceAgentContextUnavailable
} from './use-workspace-agent-context'
import {
  agentsInContext,
  countPresent,
  filterReportByAgents,
  filterReportByScope,
  groupSkillsBySource,
  isPathInside,
  selectSkillsForAgents,
  selectSkillsForScope,
  selectWorkspaceSkills
} from './workspace-context-model'
import { WorkspaceContextHeader, workspaceContextHostLabel } from './workspace-context-header'
import { ContextRow, ContextSection, EmptyRow } from './workspace-context-rows'
import {
  HookFilesBody,
  InstructionFilesBody,
  McpFilesBody,
  PluginsBody
} from './workspace-context-sections'
import {
  useWorkspaceContextViewOptions,
  type ContextSectionKey
} from './workspace-context-view-options'

const DEFAULT_OPEN: Record<ContextSectionKey, boolean> = {
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

function unavailableText(reason: WorkspaceAgentContextUnavailable): string {
  return reason === 'ssh'
    ? translate(
        'auto.components.rightSidebar.WorkspaceContextPanel.unavailableSsh',
        'Agent context is not available for SSH workspaces yet.'
      )
    : translate(
        'auto.components.rightSidebar.WorkspaceContextPanel.unavailableRuntime',
        'Waiting for the runtime that owns this workspace.'
      )
}

function CenteredNote({ text }: { text: string }): React.JSX.Element {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center p-6 text-center text-sm text-muted-foreground">
      {text}
    </div>
  )
}

export default function WorkspaceContextPanel(): React.JSX.Element {
  const worktree = useActiveWorktree()
  const openFile = useAppStore((s) => s.openFile)
  const runtimeEnvironments = useAppStore((s) => s.runtimeEnvironments)
  const {
    hostId,
    unavailable,
    report: fullReport,
    loading,
    error,
    skills,
    skillSources,
    skillsLoading,
    refresh
  } = useWorkspaceAgentContext()
  const { options, update, setAgentEnabled, setAllAgentsEnabled, reset } =
    useWorkspaceContextViewOptions()
  const { disabledAgents, scope, section, showMissing } = options

  const workspaceCwd = fullReport?.target.cwd ?? null
  const allWorkspaceSkills = useMemo(
    () => selectWorkspaceSkills(skills, workspaceCwd),
    [skills, workspaceCwd]
  )
  const agentOptions = useMemo(() => {
    const present = new Set(agentsInContext(fullReport, allWorkspaceSkills, skillSources))
    return AGENT_CATALOG.filter((entry) => present.has(entry.id)).map((entry) => entry.id)
  }, [allWorkspaceSkills, fullReport, skillSources])
  const enabledAgents = useMemo(
    () => agentOptions.filter((agent) => !disabledAgents.includes(agent)),
    [agentOptions, disabledAgents]
  )
  const agentFilter: readonly TuiAgent[] | null = disabledAgents.length === 0 ? null : enabledAgents
  const report = useMemo(
    () => filterReportByScope(filterReportByAgents(fullReport, agentFilter), scope),
    [fullReport, agentFilter, scope]
  )
  const workspaceSkills = useMemo(
    () =>
      selectSkillsForScope(
        selectSkillsForAgents(allWorkspaceSkills, skillSources, agentFilter),
        scope
      ),
    [agentFilter, allWorkspaceSkills, scope, skillSources]
  )
  const counts = countPresent(report)
  const fullCounts = countPresent(fullReport)
  const skillGroups = useMemo(() => groupSkillsBySource(workspaceSkills), [workspaceSkills])
  const showSection = (key: ContextSectionKey): boolean => section === 'all' || section === key
  const [open, setOpen] = useState<Record<ContextSectionKey, boolean>>(DEFAULT_OPEN)
  const toggle = useCallback(
    (key: ContextSectionKey) => setOpen((current) => ({ ...current, [key]: !current[key] })),
    []
  )
  const sectionState = (key: ContextSectionKey) => ({
    open: section === key || open[key],
    onToggle: () => toggle(key)
  })
  // Why: an empty section reads differently when the unfiltered report has rows.
  const hiddenByFilter = (key: keyof typeof counts): boolean =>
    fullCounts[key] > 0 && counts[key] === 0
  const bodyProps = (key: keyof typeof counts) => ({
    report,
    showMissing,
    hiddenByFilter: hiddenByFilter(key)
  })

  const openInstructionFile = useCallback(
    (file: AgentContextInstructionFile) => {
      if (!worktree || !workspaceCwd || !isPathInside(file.path, workspaceCwd)) {
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
      <CenteredNote
        text={translate(
          'auto.components.rightSidebar.WorkspaceContextPanel.noWorkspace',
          'Select a workspace to see the context its agents load.'
        )}
      />
    )
  }

  const hostLabel = workspaceContextHostLabel({
    hostId,
    runtimeEnvironments,
    reportTarget: fullReport?.target ?? null
  })

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-background">
      <WorkspaceContextHeader
        subtitle={worktree.branch.replace(/^refs\/heads\//, '') || worktree.path}
        hostLabel={hostLabel}
        loading={loading}
        agentOptions={agentOptions}
        options={options}
        onScopeChange={(next) => update({ scope: next })}
        onSectionChange={(next) => update({ section: next })}
        onAgentEnabledChange={setAgentEnabled}
        onAllAgentsEnabledChange={(enabled) => setAllAgentsEnabled(enabled, agentOptions)}
        onShowMissingChange={(next) => update({ showMissing: next })}
        onReset={reset}
        onRefresh={refresh}
      />
      {error ? (
        <div className="border-b border-border px-4 py-2 text-xs text-destructive">{error}</div>
      ) : null}
      {unavailable ? (
        <CenteredNote text={unavailableText(unavailable)} />
      ) : (
        <div className="scrollbar-sleek min-h-0 flex-1 overflow-y-auto overflow-x-hidden">
          {showSection('instructions') && (
            <ContextSection
              title={translate(
                'auto.components.rightSidebar.WorkspaceContextPanel.instructions',
                'Instructions'
              )}
              count={report ? counts.instructionFiles : null}
              {...sectionState('instructions')}
            >
              <InstructionFilesBody
                {...bodyProps('instructionFiles')}
                onOpen={openInstructionFile}
              />
            </ContextSection>
          )}

          {showSection('skills') && (
            <ContextSection
              title={translate(
                'auto.components.rightSidebar.WorkspaceContextPanel.skills',
                'Skills'
              )}
              count={skillsLoading && workspaceSkills.length === 0 ? null : workspaceSkills.length}
              {...sectionState('skills')}
            >
              {workspaceSkills.length === 0 ? (
                <EmptyRow
                  text={
                    skillsLoading
                      ? translate(
                          'auto.components.rightSidebar.WorkspaceContextPanel.scanning',
                          'Scanning…'
                        )
                      : allWorkspaceSkills.length > 0
                        ? translate(
                            'auto.components.rightSidebar.WorkspaceContextPanel.hiddenByFilter',
                            'Hidden by the current filter.'
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
              {...sectionState('mcp')}
            >
              <McpFilesBody {...bodyProps('mcpServers')} />
            </ContextSection>
          )}

          {showSection('hooks') && (
            <ContextSection
              title={translate('auto.components.rightSidebar.WorkspaceContextPanel.hooks', 'Hooks')}
              count={report ? counts.hooks : null}
              {...sectionState('hooks')}
            >
              <HookFilesBody {...bodyProps('hooks')} />
            </ContextSection>
          )}

          {showSection('plugins') && (
            <ContextSection
              title={translate(
                'auto.components.rightSidebar.WorkspaceContextPanel.plugins',
                'Plugins'
              )}
              count={report ? counts.plugins : null}
              {...sectionState('plugins')}
            >
              <PluginsBody {...bodyProps('plugins')} />
            </ContextSection>
          )}
        </div>
      )}
    </div>
  )
}
