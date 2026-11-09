import { useId } from 'react'
import { Check, ChevronDown, CircleDashed, Minus, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { InlineError } from '@/components/ui/inline-error'
import { Skeleton } from '@/components/ui/skeleton'
import { LoadingSpinner } from '@/components/LoadingSpinner'
import { cn } from '@/lib/utils'
import { useTranslate } from '@/i18n/use-translate'
import type {
  McpSyncServerRow,
  McpSyncStatus
} from '../../../../../../shared/agent-mcp-sync/mcp-sync-contract'
import {
  mcpSyncErrorRetryable,
  mcpSyncErrorText,
  mcpSyncRowNote,
  mcpSyncRowToggleable,
  mcpSyncSummary,
  mcpSyncTimeLabel
} from './cloud-mcp-sync-copy'

const AGENT_LABEL = { claude: 'Claude Code', codex: 'Codex' } as const

export type CloudMcpSyncPanelProps = {
  status: McpSyncStatus
  expanded: boolean
  onToggleExpanded: () => void
  onSyncNow: () => void
  onToggleServer: (key: string, included: boolean) => void
  onToggleAutoSync: (autoSync: boolean) => void
}

function RowIcon({ row }: { row: McpSyncServerRow }): React.JSX.Element {
  if (row.state === 'synced') {
    return <Check aria-hidden className="size-3.5 shrink-0 text-foreground" />
  }
  if (row.state === 'pending' && row.included) {
    return <CircleDashed aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
  }
  return <Minus aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
}

function ServerRow({
  row,
  disabled,
  onToggle
}: {
  row: McpSyncServerRow
  disabled: boolean
  onToggle: (included: boolean) => void
}): React.JSX.Element {
  const t = useTranslate()
  const note = mcpSyncRowNote(row, t)
  return (
    <li className="flex items-center gap-2.5 py-1.5">
      <RowIcon row={row} />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-baseline gap-2">
          <span
            className={cn(
              'truncate font-medium',
              row.state === 'synced' ? 'text-foreground' : 'text-muted-foreground'
            )}
          >
            {row.name}
          </span>
          <span className="shrink-0 text-2xs text-muted-foreground">{AGENT_LABEL[row.agent]}</span>
          {row.target ? (
            <span className="min-w-0 truncate font-mono text-2xs text-muted-foreground">
              {row.target}
            </span>
          ) : null}
        </div>
        {note ? (
          <p className="truncate text-2xs text-muted-foreground" title={note}>
            {note}
          </p>
        ) : null}
      </div>
      {mcpSyncRowToggleable(row) ? (
        <Switch
          checked={row.included}
          disabled={disabled}
          onCheckedChange={onToggle}
          aria-label={t(
            'cloudMcpSync.toggleServer',
            'Sync {{name}} ({{agent}}) to cloud workspaces',
            {
              name: row.name,
              agent: AGENT_LABEL[row.agent]
            }
          )}
        />
      ) : null}
    </li>
  )
}

/** The panel's header line while main reads this computer's agent configs. */
export function CloudMcpSyncSkeleton(): React.JSX.Element {
  const t = useTranslate()
  return (
    <div className="mt-2 flex min-h-6 items-center gap-2 border-t border-border/60 pt-2" aria-busy>
      <span className="sr-only">{t('cloudMcpSync.loading', 'Loading MCP servers…')}</span>
      <Skeleton className="h-3 w-20" />
      <Skeleton className="h-3 w-28" />
    </div>
  )
}

/** "MCP servers: N synced, M skipped" for one Orca Cloud workspace, with per-server opt-out. */
export function CloudMcpSyncPanel({
  status,
  expanded,
  onToggleExpanded,
  onSyncNow,
  onToggleServer,
  onToggleAutoSync
}: CloudMcpSyncPanelProps): React.JSX.Element {
  const t = useTranslate()
  const listId = useId()
  const autoSyncLabelId = useId()
  const autoSyncHintId = useId()
  const error = mcpSyncErrorText(status.error, t)
  const summary = mcpSyncSummary(status, t)
  const lastSynced =
    status.lastSyncedAt === null
      ? null
      : t('cloudMcpSync.lastSynced', 'Last synced {{time}}', {
          time: mcpSyncTimeLabel(status.lastSyncedAt)
        })
  const hasRows = status.rows.length > 0
  const title = (
    <>
      <span className="font-medium text-foreground">{t('cloudMcpSync.title', 'MCP servers')}</span>
      <span className="truncate text-muted-foreground">{summary}</span>
    </>
  )
  return (
    <div className="mt-2 border-t border-border/60 pt-2 text-xs">
      <div className="flex min-h-6 items-center gap-2">
        {hasRows ? (
          <Button
            type="button"
            variant="ghost"
            size="inlineChip"
            className="-ml-1.5 min-w-0"
            aria-expanded={expanded}
            aria-controls={listId}
            title={lastSynced ?? undefined}
            onClick={onToggleExpanded}
          >
            <span className="flex min-w-0 items-center gap-1.5">
              {title}
              <ChevronDown
                aria-hidden
                className={cn(
                  'size-3 shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none',
                  expanded && 'rotate-180'
                )}
              />
            </span>
          </Button>
        ) : (
          <div className="flex min-w-0 items-center gap-1.5">{title}</div>
        )}
        <span className="sr-only" role="status">
          {status.running ? t('cloudMcpSync.syncing', 'Syncing MCP servers…') : summary}
        </span>
        <span className="flex-1" />
        {hasRows && !mcpSyncErrorRetryable(status.error) ? (
          <Button
            type="button"
            variant="ghost"
            size="xs"
            onClick={onSyncNow}
            disabled={status.running || status.error === 'host-outdated'}
          >
            {status.running ? <LoadingSpinner className="size-3" /> : <RefreshCw />}
            {t('cloudMcpSync.syncNow', 'Sync now')}
          </Button>
        ) : null}
      </div>
      {error ? (
        <InlineError
          className="mt-1.5"
          density="compact"
          tone={mcpSyncErrorRetryable(status.error) ? 'error' : 'neutral'}
          title={error}
          {...(mcpSyncErrorRetryable(status.error)
            ? {
                retryLabel: t('cloudMcpSync.syncAgain', 'Sync again'),
                onRetry: onSyncNow,
                retrying: status.running
              }
            : {})}
        />
      ) : null}
      <div id={listId} hidden={!expanded || !hasRows} className="mt-1.5 space-y-2">
        <ul className="divide-y divide-border/60">
          {status.rows.map((row) => (
            <ServerRow
              key={row.key}
              row={row}
              disabled={status.running}
              onToggle={(included) => onToggleServer(row.key, included)}
            />
          ))}
        </ul>
        <div className="flex items-center gap-2.5 border-t border-border/60 pt-2">
          <div className="min-w-0 flex-1">
            <p id={autoSyncLabelId} className="font-medium text-foreground">
              {t('cloudMcpSync.autoSync', 'Sync on connect')}
            </p>
            <p id={autoSyncHintId} className="text-2xs text-muted-foreground">
              {t(
                'cloudMcpSync.autoSyncHint',
                'Applies to all cloud workspaces. Servers added inside a workspace are left alone.'
              )}
            </p>
          </div>
          <Switch
            checked={status.autoSync}
            onCheckedChange={onToggleAutoSync}
            aria-labelledby={autoSyncLabelId}
            aria-describedby={autoSyncHintId}
          />
        </div>
        <p className="text-2xs text-muted-foreground">
          {t(
            'cloudMcpSync.egressNote',
            'Orca lets the sandbox reach each remote server’s host. Other hosts stay blocked.'
          )}
        </p>
        {lastSynced ? <p className="text-2xs text-muted-foreground">{lastSynced}</p> : null}
      </div>
    </div>
  )
}
