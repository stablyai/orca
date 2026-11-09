import { useId } from 'react'
import { Check, ChevronDown, CircleDashed, Minus, RefreshCw, TriangleAlert } from 'lucide-react'
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
  mcpSyncRowStateLabel,
  mcpSyncRowToggleable,
  mcpSyncSortRows,
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
  if (row.state === 'synced' && row.unreachable) {
    return <TriangleAlert aria-hidden className="size-3.5 shrink-0 text-status-warning" />
  }
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
          <span className="sr-only">{mcpSyncRowStateLabel(row, t)}</span>
          <span className="shrink-0 text-2xs text-muted-foreground/70">
            {AGENT_LABEL[row.agent]}
          </span>
          {row.target ? (
            <span className="min-w-0 truncate font-mono text-2xs text-muted-foreground">
              {row.target}
            </span>
          ) : null}
        </div>
        {note ? <p className="line-clamp-2 text-2xs text-muted-foreground">{note}</p> : null}
      </div>
      {mcpSyncRowToggleable(row) ? (
        <Switch
          checked={row.included}
          // aria-disabled, not disabled: the switch just pressed keeps focus while its sync runs.
          aria-disabled={disabled || undefined}
          title={t('cloudMcpSync.appliesEverywhere', 'Applies to every cloud workspace')}
          onCheckedChange={(next) => {
            if (!disabled) {
              onToggle(next)
            }
          }}
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
    <div
      className="mt-2 flex min-h-6 items-center gap-1.5 border-t border-border/60 pt-2 text-xs"
      aria-busy
    >
      <span className="font-medium text-foreground">{t('cloudMcpSync.title', 'MCP servers')}</span>
      <span className="sr-only">{t('cloudMcpSync.loading', 'Loading MCP servers…')}</span>
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
          {status.running
            ? t('cloudMcpSync.syncing', 'Syncing MCP servers…')
            : error
              ? null
              : summary}
        </span>
        <span className="flex-1" />
        {hasRows && status.error !== 'host-outdated' && !mcpSyncErrorRetryable(status.error) ? (
          <Button
            type="button"
            variant="ghost"
            size="xs"
            onClick={status.running ? undefined : onSyncNow}
            aria-disabled={status.running || undefined}
            aria-busy={status.running || undefined}
          >
            {status.running ? <LoadingSpinner className="size-3" /> : <RefreshCw />}
            {status.running
              ? t('cloudMcpSync.syncingShort', 'Syncing…')
              : t('cloudMcpSync.syncNow', 'Sync now')}
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
          {mcpSyncSortRows(status.rows).map((row) => (
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
                'Applies to every cloud workspace. Servers added inside the sandbox are left alone.'
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
        <p className="border-t border-border/60 pt-2 text-2xs text-muted-foreground">
          {lastSynced ? (
            <>
              <span>{lastSynced}</span>
              <span aria-hidden className="px-1">
                ·
              </span>
            </>
          ) : null}
          <span>
            {t(
              'cloudMcpSync.egressNote',
              'Orca opens the sandbox’s network to each remote server’s host. Other hosts stay blocked.'
            )}
          </span>
        </p>
      </div>
    </div>
  )
}
