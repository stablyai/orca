import React, { useCallback, useMemo, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import type { AgentContextInstructionFile } from '../../../../shared/agent-context'
import { detectLanguage } from '@/lib/language-detect'
import { joinPath } from '@/lib/path'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { useActiveWorktree } from '@/store/selectors'
import { useWorkspaceAgentContext } from './use-workspace-agent-context'
import {
  countPresent,
  formatBytes,
  groupInstructionFiles,
  groupSkillsBySource,
  isPathInside,
  selectWorkspaceSkills,
  sortByScope
} from './workspace-context-model'
import { ContextRow, ContextSection, EmptyRow, scopeLabel } from './workspace-context-rows'

type SectionKey = 'instructions' | 'skills' | 'mcp' | 'hooks' | 'plugins'

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

export default function WorkspaceContextPanel(): React.JSX.Element {
  const worktree = useActiveWorktree()
  const openFile = useAppStore((s) => s.openFile)
  const { report, loading, error, skills, skillsLoading, refresh } = useWorkspaceAgentContext()
  const [showMissing, setShowMissing] = useState(false)
  const [open, setOpen] = useState<Record<SectionKey, boolean>>(DEFAULT_OPEN)
  const toggle = useCallback(
    (key: SectionKey) => setOpen((current) => ({ ...current, [key]: !current[key] })),
    []
  )

  const workspaceCwd = report?.target.cwd ?? null
  const workspaceSkills = useMemo(
    () => selectWorkspaceSkills(skills, workspaceCwd),
    [skills, workspaceCwd]
  )
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
        <button
          type="button"
          onClick={refresh}
          aria-label={translate(
            'auto.components.rightSidebar.WorkspaceContextPanel.refresh',
            'Refresh'
          )}
          title={translate('auto.components.rightSidebar.WorkspaceContextPanel.refresh', 'Refresh')}
          className="rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <RefreshCw className={cn('size-3.5', loading && 'animate-spin')} />
        </button>
      </div>
      <label className="flex cursor-pointer items-center gap-2 border-b border-border px-4 py-1.5 text-[11px] text-muted-foreground">
        <input
          type="checkbox"
          className="size-3"
          checked={showMissing}
          onChange={(event) => setShowMissing(event.target.checked)}
        />
        {translate(
          'auto.components.rightSidebar.WorkspaceContextPanel.showMissing',
          'Show locations that were checked but empty'
        )}
      </label>
      {error ? (
        <div className="border-b border-border px-4 py-2 text-xs text-destructive">{error}</div>
      ) : null}
      <div className="scrollbar-sleek min-h-0 flex-1 overflow-y-auto">
        <ContextSection
          title={translate(
            'auto.components.rightSidebar.WorkspaceContextPanel.instructions',
            'Instructions'
          )}
          count={report ? counts.instructionFiles : null}
          open={open.instructions}
          onToggle={() => toggle('instructions')}
        >
          {instructionGroups.length === 0 ? (
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

        <ContextSection
          title={translate('auto.components.rightSidebar.WorkspaceContextPanel.skills', 'Skills')}
          count={skillsLoading && workspaceSkills.length === 0 ? null : workspaceSkills.length}
          open={open.skills}
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

        <ContextSection
          title={translate('auto.components.rightSidebar.WorkspaceContextPanel.mcp', 'MCP servers')}
          count={report ? counts.mcpServers : null}
          open={open.mcp}
          onToggle={() => toggle('mcp')}
        >
          {report && report.mcpFiles.every((file) => !file.inspection.exists) && !showMissing ? (
            <EmptyRow
              text={translate(
                'auto.components.rightSidebar.WorkspaceContextPanel.noMcp',
                'No MCP config files found.'
              )}
            />
          ) : (
            sortByScope(report?.mcpFiles ?? [])
              .filter((file) => file.inspection.exists || showMissing)
              .map((file) => (
                <div key={file.id}>
                  <ContextRow
                    primary={file.inspection.candidate.label}
                    secondary={file.path}
                    meta={
                      !file.inspection.exists
                        ? translate(
                            'auto.components.rightSidebar.WorkspaceContextPanel.missing',
                            'not found'
                          )
                        : file.inspection.status === 'invalid'
                          ? translate(
                              'auto.components.rightSidebar.WorkspaceContextPanel.invalid',
                              'invalid'
                            )
                          : String(file.inspection.servers.length)
                    }
                    agents={file.agents}
                    muted={!file.inspection.exists}
                    title={file.inspection.error ?? file.path}
                  />
                  {file.inspection.servers.map((server) => (
                    <div
                      key={`${file.id}:${server.name}`}
                      className="flex items-baseline gap-2 py-0.5 pl-6 pr-3 text-xs"
                    >
                      <span
                        className={cn(
                          'min-w-0 truncate',
                          server.status === 'enabled'
                            ? 'text-foreground'
                            : 'text-muted-foreground line-through'
                        )}
                      >
                        {server.name}
                      </span>
                      <span className="ml-auto shrink-0 font-mono text-[10px] text-muted-foreground">
                        {server.transport === 'http'
                          ? (server.url ?? server.transport)
                          : (server.command ?? server.transport)}
                      </span>
                    </div>
                  ))}
                </div>
              ))
          )}
        </ContextSection>

        <ContextSection
          title={translate('auto.components.rightSidebar.WorkspaceContextPanel.hooks', 'Hooks')}
          count={report ? counts.hooks : null}
          open={open.hooks}
          onToggle={() => toggle('hooks')}
        >
          {sortByScope(report?.hookFiles ?? [])
            .filter((file) => file.hookCount > 0 || file.error || showMissing)
            .map((file) => (
              <ContextRow
                key={file.id}
                primary={
                  file.error
                    ? translate(
                        'auto.components.rightSidebar.WorkspaceContextPanel.invalidSettings',
                        'Invalid settings file'
                      )
                    : file.events.length > 0
                      ? file.events.join(', ')
                      : translate(
                          'auto.components.rightSidebar.WorkspaceContextPanel.noHooksInFile',
                          'No hooks'
                        )
                }
                secondary={file.path}
                meta={
                  file.exists
                    ? String(file.hookCount)
                    : translate(
                        'auto.components.rightSidebar.WorkspaceContextPanel.missing',
                        'not found'
                      )
                }
                agents={file.agents}
                muted={!file.exists || file.hookCount === 0}
                title={file.error ?? file.path}
              />
            ))}
          {report && counts.hooks === 0 && !showMissing ? (
            <EmptyRow
              text={translate(
                'auto.components.rightSidebar.WorkspaceContextPanel.noHooks',
                'No agent hooks configured.'
              )}
            />
          ) : null}
        </ContextSection>

        <ContextSection
          title={translate('auto.components.rightSidebar.WorkspaceContextPanel.plugins', 'Plugins')}
          count={report ? counts.plugins : null}
          open={open.plugins}
          onToggle={() => toggle('plugins')}
        >
          {report && report.plugins.length === 0 ? (
            <EmptyRow
              text={translate(
                'auto.components.rightSidebar.WorkspaceContextPanel.noPlugins',
                'No plugin settings found.'
              )}
            />
          ) : (
            (report?.plugins ?? [])
              .filter((plugin) => plugin.enabled || showMissing)
              .map((plugin) => (
                <ContextRow
                  key={plugin.id}
                  primary={plugin.name}
                  secondary={plugin.sourcePath}
                  meta={
                    plugin.enabled
                      ? translate(
                          'auto.components.rightSidebar.WorkspaceContextPanel.enabled',
                          'enabled'
                        )
                      : translate(
                          'auto.components.rightSidebar.WorkspaceContextPanel.disabled',
                          'disabled'
                        )
                  }
                  agents={plugin.agents}
                  muted={!plugin.enabled}
                  title={plugin.sourcePath}
                />
              ))
          )}
        </ContextSection>
      </div>
    </div>
  )
}
