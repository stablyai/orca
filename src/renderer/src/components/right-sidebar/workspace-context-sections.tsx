import type React from 'react'
import type {
  AgentContextInstructionFile,
  AgentContextReport
} from '../../../../shared/agent-context'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import { formatBytes, groupInstructionFiles, sortByScope } from './workspace-context-model'
import { ContextRow, EmptyRow, scopeLabel } from './workspace-context-rows'

type SectionBodyProps = {
  /** Already narrowed by the agent and scope filters. */
  report: AgentContextReport | null
  showMissing: boolean
  /** The unfiltered report has rows here; the filters hid all of them. */
  hiddenByFilter: boolean
}

function emptyText(hiddenByFilter: boolean, none: string): string {
  return hiddenByFilter
    ? translate(
        'auto.components.rightSidebar.WorkspaceContextPanel.hiddenByFilter',
        'Hidden by the current filter.'
      )
    : none
}

export function InstructionFilesBody({
  report,
  showMissing,
  hiddenByFilter,
  onOpen
}: SectionBodyProps & {
  onOpen: (file: AgentContextInstructionFile) => void
}): React.JSX.Element {
  const groups = groupInstructionFiles(report?.instructionFiles ?? [], showMissing)
  if (report && groups.length === 0) {
    return (
      <EmptyRow
        text={emptyText(
          hiddenByFilter,
          translate(
            'auto.components.rightSidebar.WorkspaceContextPanel.noInstructions',
            'No instruction files found for this workspace.'
          )
        )}
      />
    )
  }
  return (
    <>
      {groups.map((group) => (
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
                  ? () => onOpen(file)
                  : undefined
              }
              title={file.path}
            />
          ))}
        </div>
      ))}
    </>
  )
}

export function McpFilesBody({
  report,
  showMissing,
  hiddenByFilter
}: SectionBodyProps): React.JSX.Element {
  const files = sortByScope(report?.mcpFiles ?? []).filter(
    (file) => file.inspection.exists || showMissing
  )
  return (
    <>
      {report && files.length === 0 ? (
        <EmptyRow
          text={emptyText(
            hiddenByFilter,
            translate(
              'auto.components.rightSidebar.WorkspaceContextPanel.noMcp',
              'No MCP config files found.'
            )
          )}
        />
      ) : (
        files.map((file) => (
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
                <span
                  className="ml-auto min-w-0 max-w-[60%] truncate font-mono text-[10px] text-muted-foreground"
                  title={server.transport === 'http' ? server.url : server.command}
                >
                  {server.transport === 'http'
                    ? (server.url ?? server.transport)
                    : (server.command ?? server.transport)}
                </span>
              </div>
            ))}
          </div>
        ))
      )}
    </>
  )
}

export function HookFilesBody({
  report,
  showMissing,
  hiddenByFilter
}: SectionBodyProps): React.JSX.Element {
  const files = sortByScope(report?.hookFiles ?? []).filter(
    (file) => file.hookCount > 0 || file.error || showMissing
  )
  return (
    <>
      {files.map((file) => (
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
              : translate('auto.components.rightSidebar.WorkspaceContextPanel.missing', 'not found')
          }
          agents={file.agents}
          muted={!file.exists || file.hookCount === 0}
          title={file.error ?? file.path}
        />
      ))}
      {report && files.length === 0 ? (
        <EmptyRow
          text={emptyText(
            hiddenByFilter,
            translate(
              'auto.components.rightSidebar.WorkspaceContextPanel.noHooks',
              'No agent hooks configured.'
            )
          )}
        />
      ) : null}
    </>
  )
}

export function PluginsBody({
  report,
  showMissing,
  hiddenByFilter
}: SectionBodyProps): React.JSX.Element {
  const plugins = (report?.plugins ?? []).filter((plugin) => plugin.enabled || showMissing)
  return (
    <>
      {report && plugins.length === 0 ? (
        <EmptyRow
          text={emptyText(
            hiddenByFilter,
            translate(
              'auto.components.rightSidebar.WorkspaceContextPanel.noPlugins',
              'No enabled plugins found.'
            )
          )}
        />
      ) : (
        plugins.map((plugin) => (
          <ContextRow
            key={plugin.id}
            primary={plugin.name}
            secondary={plugin.sourcePath}
            meta={
              plugin.enabled
                ? translate('auto.components.rightSidebar.WorkspaceContextPanel.enabled', 'enabled')
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
    </>
  )
}
