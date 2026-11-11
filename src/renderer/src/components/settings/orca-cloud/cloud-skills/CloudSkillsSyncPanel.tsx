import { useId, useState } from 'react'
import { Check, ChevronDown, ChevronRight, CircleDashed, Minus, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { InlineError } from '@/components/ui/inline-error'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { LoadingSpinner } from '@/components/LoadingSpinner'
import { useNow } from '@/hooks/use-now'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/utils'
import type {
  AgentConfigSyncRow,
  AgentConfigSyncStatus
} from '../../../../../../shared/agent-config-sync/agent-config-sync-contract'
import { formatRelative } from '../../../cloud-workspaces/cloud-workspace-format'
import {
  cloudSkillsDisplayName,
  cloudSkillsErrorRetryable,
  cloudSkillsErrorText,
  cloudSkillsKindLabel,
  cloudSkillsRowIncluded,
  cloudSkillsRowNote,
  cloudSkillsRowStateLabel,
  cloudSkillsRowToggleable,
  cloudSkillsEntryCount,
  cloudSkillsEntryKeys,
  cloudSkillsEntryKindLabel,
  cloudSkillsGroupRows,
  type CloudSkillsEntry,
  cloudSkillsSummary
} from './cloud-skills-sync-copy'

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
}

function RowIcon({
  row,
  included
}: {
  row: AgentConfigSyncRow
  included: boolean
}): React.JSX.Element {
  if (row.state === 'synced') {
    return <Check aria-hidden className="size-3.5 shrink-0 text-foreground" />
  }
  if (row.state === 'pending' && included) {
    return <CircleDashed aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
  }
  return <Minus aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
}

function ItemRow({
  row,
  included,
  disabled,
  isCopy = false,
  kindLabel,
  onToggle
}: {
  row: AgentConfigSyncRow
  included: boolean
  disabled: boolean
  /** A copy for the other agent: indented under its original, whose switch it follows. */
  isCopy?: boolean
  /** A row standing for the same skill in both agents' folders: "Claude skill, Codex skill". */
  kindLabel?: string
  onToggle: (included: boolean) => void
}): React.JSX.Element {
  const t = useTranslate()
  const note = cloudSkillsRowNote(row, t)
  const name = cloudSkillsDisplayName(row)
  const kind = kindLabel ?? cloudSkillsKindLabel(row, t)
  return (
    <li className={cn('flex items-center gap-2.5 py-1.5', isCopy && 'pl-6')}>
      <RowIcon row={row} included={included} />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-baseline gap-2">
          <span
            className={cn(
              'truncate font-medium',
              row.state === 'synced' ? 'text-foreground' : 'text-muted-foreground'
            )}
          >
            {name}
          </span>
          <span className="sr-only">{cloudSkillsRowStateLabel(row, included, t)}</span>
          <span className="shrink-0 text-2xs text-muted-foreground">{kind}</span>
        </div>
        {note ? <p className="line-clamp-2 text-2xs text-muted-foreground">{note}</p> : null}
      </div>
      {!isCopy && cloudSkillsRowToggleable(row) ? (
        <Switch
          checked={included}
          // aria-disabled, not disabled: the switch just pressed keeps focus while its sync runs.
          aria-disabled={disabled || undefined}
          title={t('cloudSkillsSync.appliesEverywhere', 'Applies to every cloud workspace')}
          onCheckedChange={(next) => {
            if (!disabled) {
              onToggle(next)
            }
          }}
          aria-label={t(
            'cloudSkillsSync.toggleItem',
            'Sync {{name}} ({{kind}}) to cloud workspaces',
            {
              name,
              kind
            }
          )}
        />
      ) : null}
    </li>
  )
}

/** A Synced list longer than this starts collapsed; Not synced, the part to act on, never does. */
const COLLAPSE_SYNCED_OVER = 10

function Group({
  title,
  entries,
  excluded,
  disabled,
  collapsible = false,
  onToggleItem
}: {
  title: string
  entries: CloudSkillsEntry[]
  excluded: ReadonlySet<string>
  disabled: boolean
  collapsible?: boolean
  onToggleItem: (key: string, included: boolean) => void
}): React.JSX.Element | null {
  const t = useTranslate()
  const headingId = useId()
  const listId = useId()
  const count = cloudSkillsEntryCount(entries)
  const [open, setOpen] = useState(!collapsible || count <= COLLAPSE_SYNCED_OVER)
  if (entries.length === 0) {
    return null
  }
  return (
    <section aria-labelledby={headingId}>
      {collapsible ? (
        <h4 id={headingId} className="pt-1">
          <Button
            type="button"
            variant="quiet"
            size="statusAction"
            className="-ml-1"
            aria-expanded={open}
            aria-controls={listId}
            onClick={() => setOpen((value) => !value)}
          >
            {title} · {count}
            <ChevronRight
              aria-hidden
              className={cn(
                'size-3 transition-transform motion-reduce:transition-none',
                open && 'rotate-90'
              )}
            />
          </Button>
        </h4>
      ) : (
        <h4 id={headingId} className="pt-1 text-2xs font-medium text-muted-foreground">
          {title} · {count}
        </h4>
      )}
      <ul id={listId} hidden={!open}>
        {entries.flatMap((entry) => {
          const { row, twins, copies } = entry
          const keys = cloudSkillsEntryKeys(entry)
          return [
            <ItemRow
              key={row.key}
              row={row}
              included={keys.every((key) => !excluded.has(key))}
              disabled={disabled}
              kindLabel={twins.length > 0 ? cloudSkillsEntryKindLabel(entry, t) : undefined}
              onToggle={(included) => {
                for (const key of keys) {
                  onToggleItem(key, included)
                }
              }}
            />,
            ...copies.map((copy) => (
              <ItemRow
                key={copy.key}
                row={copy}
                included={cloudSkillsRowIncluded(copy, excluded)}
                disabled={disabled}
                isCopy
                onToggle={() => {}}
              />
            ))
          ]
        })}
      </ul>
    </section>
  )
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
  onToggleItem
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
        {hasRows ? (
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
        ) : (
          <div className="flex min-w-0 items-center gap-1.5">{title}</div>
        )}
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
      <div id={listId} hidden={!expanded || !hasRows} className="mt-1.5 space-y-2">
        <Group
          title={t('cloudSkillsSync.group.synced', 'Synced')}
          entries={groups.synced}
          collapsible
          excluded={excluded}
          disabled={status.running}
          onToggleItem={onToggleItem}
        />
        <Group
          title={t('cloudSkillsSync.group.pending', 'Not synced yet')}
          entries={groups.pending}
          excluded={excluded}
          disabled={status.running}
          onToggleItem={onToggleItem}
        />
        <Group
          title={t('cloudSkillsSync.group.notSynced', 'Not synced')}
          entries={groups.notSynced}
          excluded={excluded}
          disabled={status.running}
          onToggleItem={onToggleItem}
        />
      </div>
    </div>
  )
}
