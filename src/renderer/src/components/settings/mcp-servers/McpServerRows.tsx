// The MCP servers page's rows: a server (opens its page), Add a server, and a server found in an agent.
import React from 'react'
import { ChevronRight, Copy, Ellipsis, FileText, Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/class-names'
import { useTranslate } from '@/i18n/use-translate'
import { BotToolLogo } from '@/components/bots/apps/BotToolAppRow'
import {
  mcpMoveRemovesFrom,
  type DiscoveredMcpServer
} from '../../../../../shared/mcp-servers/mcp-servers'
import type { McpRowStatus } from './mcp-server-words'
import { mcpAgentLabel, mcpServerTitle } from './mcp-server-words'

// The settings shell pads every row 9px; 42px inside makes the 60px row of a tool list.
const ROW_BODY = 'flex min-h-[42px] w-full items-center gap-3'
const ROW = `${ROW_BODY} text-left outline-none focus-visible:rounded-md focus-visible:ring-2 focus-visible:ring-ring/50`

export const MCP_STATUS_DOT: Record<McpRowStatus['tone'], string | null> = {
  success: null,
  attention: 'bg-status-warning',
  failed: 'bg-destructive'
}

/** A row's second line: the server's line, then its status after a dot, or a failure alone. */
export function McpStatusLine({
  line,
  status
}: {
  line: string | null
  status: McpRowStatus | null
}): React.JSX.Element {
  const dot = status ? MCP_STATUS_DOT[status.tone] : null
  const shownLine = status?.replacesLine ? null : line
  return (
    <span className="flex min-w-0 items-center gap-1.5 text-xs leading-4 text-muted-foreground">
      {shownLine ? <span className="min-w-0 truncate">{shownLine}</span> : null}
      {shownLine && status ? <span aria-hidden>·</span> : null}
      {status ? (
        <span className="flex min-w-0 shrink-0 items-center gap-1.5">
          {dot ? <span aria-hidden className={cn('size-1.5 shrink-0 rounded-full', dot)} /> : null}
          <span className="truncate">{status.label}</span>
        </span>
      ) : null}
    </span>
  )
}

/** A server on the list: a click opens its page; one that needs a sign-in offers it instead. */
export function McpServerListRow({
  name,
  detail,
  line,
  status,
  summary,
  onOpen,
  onSignIn
}: {
  name: string
  detail: string
  line: string
  status: McpRowStatus | null
  summary: string
  onOpen: () => void
  onSignIn?: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const title = mcpServerTitle(name)
  return (
    <div data-settings-row="" className="relative flex items-center gap-3">
      <button type="button" onClick={onOpen} className={cn(ROW, 'min-w-0 flex-1')}>
        <BotToolLogo name={name} detail={detail} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm leading-5 font-medium">{title}</span>
          <McpStatusLine line={line} status={status} />
        </span>
        {onSignIn ? null : (
          <span className="flex max-w-[45%] min-w-0 shrink-0 items-center gap-2 text-xs text-muted-foreground">
            <span className="truncate" title={summary}>
              {summary}
            </span>
            <ChevronRight className="size-4 shrink-0" />
          </span>
        )}
      </button>
      {onSignIn ? (
        <Button variant="secondary" size="pill" className="shrink-0" onClick={onSignIn}>
          {t('settings.mcpServers.signIn', 'Sign in')}
        </Button>
      ) : null}
    </div>
  )
}

export function McpAddServerRow({
  label,
  onOpen
}: {
  label: string
  onOpen: () => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      data-settings-row=""
      onClick={onOpen}
      className="block w-full text-left outline-none focus-visible:rounded-md focus-visible:ring-2 focus-visible:ring-ring/50"
    >
      <span className={ROW_BODY}>
        <span className="flex size-8 shrink-0 items-center justify-center rounded-md border border-dashed border-muted-foreground/50 text-muted-foreground">
          <Plus className="size-4" />
        </span>
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{label}</span>
      </span>
    </button>
  )
}

// A user's home folder on macOS, Linux or Windows.
const HOME_PREFIX = /^(?:\/Users\/[^/]+|\/home\/[^/]+|[A-Za-z]:\\Users\\[^\\]+)(?=[\\/])/

/** ~/.claude.json for a file under a home folder; the path as it is otherwise. */
function shortPath(path: string): string {
  return path.replace(HOME_PREFIX, '~')
}

/**
 * A server set up in the host's agents: Move to Orca, or from ⋯, copy it or open its files. When
 * Orca's list reaches none of its agents, Move would take nothing out, so the row offers Copy.
 */
export function McpDiscoveredRow({
  server,
  busy,
  onMove,
  onCopy,
  onOpenFile
}: {
  server: DiscoveredMcpServer
  busy: boolean
  onMove: () => void
  onCopy: () => void
  /** Opens a settings file on this computer; none for another host's files. */
  onOpenFile?: (path: string) => void
}): React.JSX.Element {
  const t = useTranslate()
  const title = mcpServerTitle(server.name)
  const moves = mcpMoveRemovesFrom(server).length > 0
  // A row lists them ("Claude Code, Codex"); the group's summary says them as a sentence.
  const agents = server.agents.map(mcpAgentLabel).join(', ')
  const line =
    server.projectNames.length > 0
      ? t('settings.mcpServers.found.onlyIn', '{{agents}} · {{projects}} only', {
          agents,
          projects: server.projectNames.join(', ')
        })
      : agents
  return (
    <div data-settings-row="">
      <div className={ROW_BODY}>
        <BotToolLogo name={server.name} detail={server.detail} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm leading-5 font-medium">{title}</span>
          <span className="block truncate text-xs leading-4 text-muted-foreground">{line}</span>
        </span>
        {server.movable ? (
          <Button variant="outline" size="sm" disabled={busy} onClick={moves ? onMove : onCopy}>
            {moves
              ? t('settings.mcpServers.found.move', 'Move to Orca')
              : t('settings.mcpServers.found.copy', 'Copy to Orca')}
          </Button>
        ) : null}
        {(server.movable && moves) || (onOpenFile && server.files.length > 0) ? (
          <DropdownMenu modal={false}>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                disabled={busy}
                aria-label={t('settings.mcpServers.found.actions', '{{name}} actions', {
                  name: title
                })}
              >
                <Ellipsis className="size-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {server.movable && moves ? (
                <>
                  <DropdownMenuItem onSelect={onCopy}>
                    <Copy />
                    {t('settings.mcpServers.found.copy', 'Copy to Orca')}
                  </DropdownMenuItem>
                  {onOpenFile && server.files.length > 0 ? <DropdownMenuSeparator /> : null}
                </>
              ) : null}
              {(onOpenFile ? server.files : []).map((file) => (
                <DropdownMenuItem key={file} onSelect={() => onOpenFile?.(file)}>
                  <FileText />
                  <span className="min-w-0 truncate">
                    {t('settings.mcpServers.found.open', 'Open')}{' '}
                    <span className="font-mono">{shortPath(file)}</span>
                  </span>
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
      </div>
    </div>
  )
}
