import { Check, ChevronDown, CircleDashed, Minus, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { LoadingSpinner } from '@/components/LoadingSpinner'
import { cn } from '@/lib/utils'
import { useTranslate } from '@/i18n/use-translate'
import type {
  McpSyncServerRow,
  McpSyncStatus
} from '../../../../../../shared/agent-mcp-sync/mcp-sync-contract'
import { mcpSyncErrorText, mcpSyncRowNote, mcpSyncSummary } from './cloud-mcp-sync-copy'

const AGENT_LABEL = { claude: 'Claude Code', codex: 'Codex' } as const

// Skips that a toggle can't fix: the server can't run in the workspace whatever the user picks.
const STRUCTURAL_SKIPS = new Set(['in-repo', 'local-command', 'local-path', 'local-url', 'invalid'])

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
  if (row.state === 'pending') {
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
  const toggleable = !row.skipReason || !STRUCTURAL_SKIPS.has(row.skipReason)
  return (
    <li className="flex items-center gap-2.5 py-1.5">
      <RowIcon row={row} />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-baseline gap-2">
          <span className="truncate text-[13px] font-medium text-foreground">{row.name}</span>
          <span className="shrink-0 text-2xs text-muted-foreground">{AGENT_LABEL[row.agent]}</span>
          {row.target ? (
            <span className="min-w-0 truncate font-mono text-2xs text-muted-foreground">
              {row.target}
            </span>
          ) : null}
        </div>
        {note ? <p className="truncate text-2xs text-muted-foreground">{note}</p> : null}
      </div>
      {toggleable ? (
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
  const error = mcpSyncErrorText(status.error, t)
  const listId = `cloud-mcp-sync-${status.environmentId}`
  return (
    <div className="rounded-md border border-border bg-muted/30 px-3 py-2 text-xs">
      <div className="flex min-h-6 items-center gap-2">
        <Button
          type="button"
          variant="ghost"
          size="inlineChip"
          className="-ml-1.5 min-w-0 gap-1.5"
          aria-expanded={expanded}
          aria-controls={listId}
          onClick={onToggleExpanded}
          disabled={status.rows.length === 0}
        >
          <span className="font-medium text-foreground">
            {t('cloudMcpSync.title', 'MCP servers')}
          </span>
          <span className="truncate text-muted-foreground" aria-live="polite">
            {mcpSyncSummary(status, t)}
          </span>
          {status.rows.length > 0 ? (
            <ChevronDown
              aria-hidden
              className={cn(
                'size-3 shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none',
                expanded && 'rotate-180'
              )}
            />
          ) : null}
        </Button>
        <span className="flex-1" />
        <Button
          type="button"
          variant="outline"
          size="xs"
          onClick={onSyncNow}
          disabled={status.running}
        >
          {status.running ? <LoadingSpinner className="size-3" /> : <RefreshCw />}
          {t('cloudMcpSync.syncNow', 'Sync now')}
        </Button>
      </div>
      {error ? <p className="mt-1 text-destructive">{error}</p> : null}
      {expanded && status.rows.length > 0 ? (
        <div id={listId} className="mt-1.5 space-y-2 border-t border-border pt-2">
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
          <label className="flex items-center gap-2.5 border-t border-border pt-2">
            <span className="flex-1 text-muted-foreground">
              {t(
                'cloudMcpSync.autoSync',
                'Sync each time a cloud workspace connects. Servers you add in the workspace are never changed.'
              )}
            </span>
            <Switch checked={status.autoSync} onCheckedChange={onToggleAutoSync} />
          </label>
          {status.lastSyncedAt !== null ? (
            <p className="text-2xs text-muted-foreground">
              {t('cloudMcpSync.lastSynced', 'Last synced at {{time}}', {
                time: new Date(status.lastSyncedAt).toLocaleTimeString(undefined, {
                  hour: 'numeric',
                  minute: '2-digit'
                })
              })}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
