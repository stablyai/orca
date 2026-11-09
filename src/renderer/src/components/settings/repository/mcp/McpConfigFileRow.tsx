import type { LoadedMcpConfigInspection } from '../../../../runtime/mcp/configuration/mcp-config-inspection'
import { AlertCircle, CheckCircle2 } from 'lucide-react'

import { Button } from '../../../ui/button'
import { translate } from '@/i18n/i18n'
import { useTranslate, type Translate } from '@/i18n/use-translate'

type McpConfigFileRowProps = {
  config: LoadedMcpConfigInspection
  onOpen: (config: LoadedMcpConfigInspection) => void
}

function statusLabel(config: LoadedMcpConfigInspection, t: Translate = translate): string {
  if (config.readError) {
    return t('settings.mcp.unreadable', 'Unreadable')
  }
  if (config.status === 'missing') {
    return t('settings.mcp.notFound', 'Not found')
  }
  if (config.status === 'invalid') {
    return t('settings.mcp.invalidJson', 'Invalid JSON')
  }
  if (config.servers.length === 0) {
    return t('settings.mcp.noServers', 'No servers')
  }
  return t('settings.mcp.serverCount', '{{count}} servers', {
    count: config.servers.length,
    defaultValue_one: '{{count}} server'
  })
}

function statusClassName(config: LoadedMcpConfigInspection): string {
  if (config.readError || config.status === 'invalid') {
    return 'border-destructive/30 bg-destructive/10 text-destructive'
  }
  if (config.status === 'valid' && config.servers.length > 0) {
    return 'border-border/60 bg-background text-foreground'
  }
  return 'border-border/60 bg-muted/60 text-muted-foreground'
}

function serverDetailLabel(
  server: LoadedMcpConfigInspection['servers'][number],
  t: Translate = translate
): string {
  if (server.transport === 'http') {
    return server.url ?? t('settings.mcp.httpServer', 'HTTP server')
  }
  if (server.transport === 'stdio') {
    return server.command ?? t('settings.mcp.stdioServer', 'stdio server')
  }
  return server.issue ?? t('settings.mcp.invalidServer', 'Invalid server')
}

export function McpConfigFileRow({ config, onOpen }: McpConfigFileRowProps): React.JSX.Element {
  const t = useTranslate()
  return (
    <div data-settings-row="" className="space-y-2 py-3">
      <div className="flex items-center gap-2">
        {config.status === 'valid' && !config.readError ? (
          <CheckCircle2 className="size-3.5 shrink-0 text-muted-foreground" />
        ) : (
          <AlertCircle className="size-3.5 shrink-0 text-destructive" />
        )}
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <p className="truncate text-sm font-medium">
              {config.candidate.relativePath === '.mcp.json'
                ? t('settings.mcp.workspace', 'Workspace')
                : config.candidate.relativePath === '.claude/mcp.json'
                  ? t('settings.mcp.claudeWorkspace', 'Claude workspace')
                  : config.candidate.label}
            </p>
            <p className="truncate font-mono text-[11px] text-muted-foreground">
              {config.candidate.relativePath}
            </p>
          </div>
        </div>
        <span
          className={`shrink-0 rounded-full border px-1.5 py-0.5 text-[10px] font-medium ${statusClassName(config)}`}
        >
          {statusLabel(config, t)}
        </span>
        {config.exists ? (
          <Button variant="outline" size="xs" onClick={() => onOpen(config)}>
            {t('auto.components.settings.McpConfigFileRow.e720c139cd', 'Open')}
          </Button>
        ) : null}
      </div>

      {config.error || config.readError ? (
        <p className="pl-5 text-xs text-destructive">{config.readError ?? config.error}</p>
      ) : null}

      {config.servers.length > 0 ? (
        <div className="grid gap-1.5 pl-5">
          {config.servers.map((server) => (
            <div
              key={server.name}
              className="grid grid-cols-[minmax(0,1fr)_auto] gap-2 rounded-md border border-border/40 bg-background/50 px-2.5 py-1.5"
            >
              <div className="min-w-0">
                <div className="flex items-center gap-1.5">
                  <span className="truncate text-xs font-medium">{server.name}</span>
                  <span className="rounded-full bg-muted px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wider text-muted-foreground">
                    {server.transport}
                  </span>
                </div>
                <p className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground">
                  {serverDetailLabel(server, t)}
                </p>
                {server.env && Object.keys(server.env).length > 0 ? (
                  <p className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground">
                    {t('auto.components.settings.McpConfigFileRow.b145eb6009', 'env:')}{' '}
                    {Object.entries(server.env)
                      .map(([key, value]) => `${key}=${value}`)
                      .join(', ')}
                  </p>
                ) : null}
              </div>
              <span className="self-start text-[11px] text-muted-foreground">{server.status}</span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  )
}
