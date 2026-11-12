import { useId } from 'react'
import { ChevronDown, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { InlineError } from '@/components/ui/inline-error'
import { Skeleton } from '@/components/ui/skeleton'
import { LoadingSpinner } from '@/components/LoadingSpinner'
import { useNow } from '@/hooks/use-now'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/utils'
import type { AgentConfigSyncStatus } from '../../../../../../shared/agent-config-sync/agent-config-sync-contract'
import { formatRelative } from '../../../cloud-workspaces/cloud-workspace-format'
import {
  cloudSkillsErrorRetryable,
  cloudSkillsErrorText,
  cloudSkillsGroupRows,
  cloudSkillsSummary
} from './cloud-skills-sync-copy'
import { CloudSkillsList } from './CloudSkillsList'
import type { CloudSkillsFilter } from './cloud-skills-filter'

export type CloudSkillsSyncPanelProps = {
  status: AgentConfigSyncStatus
  excluded: ReadonlySet<string>
  /** Off: nothing syncs on its own, and the panel says Sync now is a one-time copy. */
  autoSync: boolean
  /** For "synced 2 minutes ago"; fixtures pin it. */
  now?: number
  expanded: boolean
  onToggleExpanded: () => void
  onSyncNow: () => void
  onToggleItem: (key: string, included: boolean) => void
  /** Fixtures pin a filter; the app uses the one chosen earlier this session. */
  initialFilter?: CloudSkillsFilter
}

export function CloudSkillsSyncSkeleton(): React.JSX.Element {
  const t = useTranslate()
  return (
    <div
      className="mt-2 flex min-h-6 items-center gap-1.5 border-t border-border/60 pt-2 text-xs"
      aria-busy
    >
      <span className="font-medium text-foreground">
        {t('cloudSkillsSync.title', 'Skills & commands')}
      </span>
      <span className="sr-only">
        {t('cloudSkillsSync.loading', 'Loading skills and commands…')}
      </span>
      <Skeleton className="h-3 w-28" />
    </div>
  )
}

/** "Skills & commands: N synced" for one Orca Cloud workspace, with a per-item opt-out. */
export function CloudSkillsSyncPanel({
  status,
  excluded,
  autoSync,
  now: pinnedNow,
  expanded,
  onToggleExpanded,
  onSyncNow,
  onToggleItem,
  initialFilter
}: CloudSkillsSyncPanelProps): React.JSX.Element {
  const t = useTranslate()
  // A minute tick keeps "synced 2 minutes ago" honest while Settings stays open.
  const tick = useNow(60_000, pinnedNow === undefined)
  const now = pinnedNow ?? tick
  const listId = useId()
  const error = cloudSkillsErrorText(status.error, t)
  const summary = cloudSkillsSummary(status, t)
  const lastSynced =
    status.lastSyncedAt === null
      ? null
      : t('cloudSkillsSync.syncedAgo', 'synced {{time}}', {
          time: formatRelative(status.lastSyncedAt, now, t)
        })
  const groups = cloudSkillsGroupRows(status.rows)
  const hasRows = status.rows.length > 0
  const title = (
    <>
      <span className="font-medium text-foreground">
        {t('cloudSkillsSync.title', 'Skills & commands')}
      </span>
      <span className="truncate text-muted-foreground">
        {summary}
        {lastSynced && !status.running ? ` · ${lastSynced}` : null}
      </span>
    </>
  )
  return (
    <div className="mt-2 border-t border-border/60 pt-2 text-xs">
      <div className="flex min-h-6 items-center gap-2">
        <Button
          type="button"
          variant="ghost"
          size="inlineChip"
          className="-ml-1.5 min-w-0"
          aria-expanded={expanded}
          aria-controls={listId}
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
        <span className="sr-only" role="status">
          {status.running
            ? t('cloudSkillsSync.syncing', 'Syncing skills and commands…')
            : error
              ? null
              : summary}
        </span>
        <span className="flex-1" />
        {hasRows && status.error !== 'host-outdated' && !cloudSkillsErrorRetryable(status.error) ? (
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
              ? t('cloudSkillsSync.syncingShort', 'Syncing…')
              : t('cloudSkillsSync.syncNow', 'Sync now')}
          </Button>
        ) : null}
      </div>
      {error ? (
        <InlineError
          className="mt-1.5"
          density="compact"
          tone={cloudSkillsErrorRetryable(status.error) ? 'error' : 'neutral'}
          title={error}
          {...(cloudSkillsErrorRetryable(status.error)
            ? {
                retryLabel: t('cloudSkillsSync.syncAgain', 'Sync again'),
                onRetry: onSyncNow,
                retrying: status.running
              }
            : {})}
        />
      ) : null}
      {!autoSync && hasRows ? (
        <p className="mt-0.5 text-2xs text-muted-foreground">
          {t('cloudSkillsSync.manualOnly', 'Not synced automatically. Sync now copies them once.')}
        </p>
      ) : null}
      <div id={listId} hidden={!expanded} className="mt-1.5">
        <CloudSkillsList
          groups={groups}
          excluded={excluded}
          disabled={status.running}
          initialFilter={initialFilter}
          onToggleItem={onToggleItem}
        />
      </div>
    </div>
  )
}
