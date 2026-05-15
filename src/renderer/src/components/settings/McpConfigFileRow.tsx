import { AlertCircle, CheckCircle2 } from 'lucide-react'
import type { McpConfigInspection } from '../../../../shared/mcp-config'
import { Button } from '../ui/button'

export type LoadedMcpConfigInspection = McpConfigInspection & {
  absolutePath: string
  readError?: string
}

type McpConfigFileRowProps = {
  config: LoadedMcpConfigInspection
  onOpen: (config: LoadedMcpConfigInspection) => void
}

function statusLabel(config: LoadedMcpConfigInspection): string {
  if (config.readError) {
    return 'Unreadable'
  }
  if (config.status === 'missing') {
    return 'Not found'
  }
  if (config.status === 'invalid') {
    return 'Invalid JSON'
  }
  if (config.servers.length === 0) {
    return 'No servers'
  }
  return `${config.servers.length} server${config.servers.length === 1 ? '' : 's'}`
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

function serverDetailLabel(server: LoadedMcpConfigInspection['servers'][number]): string {
  if (server.transport === 'http') {
    return server.url ?? 'HTTP server'
  }
  if (server.transport === 'stdio') {
    return server.command ?? 'stdio server'
  }
  return server.issue ?? 'Invalid server'
}

export function McpConfigFileRow({ config, onOpen }: McpConfigFileRowProps): React.JSX.Element {
  return (
    <div className="space-y-2 px-3 py-2.5">
      <div className="flex items-center gap-2">
        {config.status === 'valid' && !config.readError ? (
          <CheckCircle2 className="size-3.5 shrink-0 text-muted-foreground" />
        ) : (
          <AlertCircle className="size-3.5 shrink-0 text-destructive" />
        )}
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <p className="truncate text-sm font-medium">{config.candidate.label}</p>
            <p className="truncate font-mono text-[11px] text-muted-foreground">
              {config.candidate.relativePath}
            </p>
          </div>
        </div>
        <span
          className={`shrink-0 rounded-full border px-1.5 py-0.5 text-[10px] font-medium ${statusClassName(config)}`}
        >
          {statusLabel(config)}
        </span>
        {config.exists ? (
          <Button variant="outline" size="xs" onClick={() => onOpen(config)}>
            Open
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
                  {serverDetailLabel(server)}
                </p>
                {server.env && Object.keys(server.env).length > 0 ? (
                  <p className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground">
                    env:{' '}
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
