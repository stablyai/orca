import type React from 'react'
import type { AgentContextReport } from '../../../../shared/agent-context'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import { countPresent, sortByScope } from './workspace-context-model'
import { ContextRow, EmptyRow } from './workspace-context-rows'

type SectionBodyProps = { report: AgentContextReport | null; showMissing: boolean }

export function McpFilesBody({ report, showMissing }: SectionBodyProps): React.JSX.Element {
  return (
    <>
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

export function HookFilesBody({ report, showMissing }: SectionBodyProps): React.JSX.Element {
  const counts = countPresent(report)
  return (
    <>
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
    </>
  )
}

export function PluginsBody({ report, showMissing }: SectionBodyProps): React.JSX.Element {
  return (
    <>
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
    </>
  )
}
