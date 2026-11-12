import { useId, useState } from 'react'
import { Check, CircleDashed, Minus } from 'lucide-react'
import { Switch } from '@/components/ui/switch'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import type { AgentConfigSyncRow } from '../../../../../../shared/agent-config-sync/agent-config-sync-contract'
import { SettingsSegmentedControl } from '../../form-controls/SettingsSegmentedControl'
import {
  cloudSkillsDisplayName,
  cloudSkillsEntryCount,
  cloudSkillsEntryKeys,
  cloudSkillsEntryKindLabel,
  cloudSkillsKindLabel,
  cloudSkillsRowIncluded,
  cloudSkillsRowNote,
  cloudSkillsRowStateLabel,
  cloudSkillsRowToggleable,
  type CloudSkillsEntry,
  type CloudSkillsGroups
} from './cloud-skills-sync-copy'
import {
  cloudSkillsFilterCounts,
  cloudSkillsFilterGroups,
  cloudSkillsFilterIsEmpty,
  type CloudSkillsFilter
} from './cloud-skills-filter'

function RowIcon({
  row,
  included
}: {
  row: AgentConfigSyncRow
  included: boolean
}): React.JSX.Element {
  if (row.state === 'synced' && included) {
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
  // Still in the sandbox from an earlier sync, but switched off here: it goes at the next sync.
  const turnedOff = row.state === 'synced' && !included
  const note = turnedOff
    ? t('cloudSkillsSync.row.offPending', 'Off. Removed from the sandbox at the next sync')
    : cloudSkillsRowNote(row, t)
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
              row.state === 'synced' && !turnedOff ? 'text-foreground' : 'text-muted-foreground'
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

function Group({
  title,
  entries,
  excluded,
  disabled,
  onToggleItem
}: {
  title: string
  entries: CloudSkillsEntry[]
  excluded: ReadonlySet<string>
  disabled: boolean
  onToggleItem: (entry: CloudSkillsEntry, included: boolean) => void
}): React.JSX.Element | null {
  const t = useTranslate()
  const headingId = useId()
  if (entries.length === 0) {
    return null
  }
  return (
    <section aria-labelledby={headingId}>
      <h4 id={headingId} className="pt-1 text-2xs font-medium text-muted-foreground">
        {title} · {cloudSkillsEntryCount(entries)}
      </h4>
      <ul>
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
              onToggle={(included) => onToggleItem(entry, included)}
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

// The filter outlives one panel for the app session, like other Settings view choices.
let sessionFilter: CloudSkillsFilter = 'all'

/** The list under its filter: a capped, scrolling area so the page never grows with it. */
export function CloudSkillsList({
  groups,
  excluded,
  disabled,
  initialFilter,
  onToggleItem
}: {
  groups: CloudSkillsGroups
  excluded: ReadonlySet<string>
  disabled: boolean
  initialFilter?: CloudSkillsFilter
  onToggleItem: (key: string, included: boolean) => void
}): React.JSX.Element {
  const t = useTranslate()
  const [filter, setFilterState] = useState<CloudSkillsFilter>(initialFilter ?? sessionFilter)
  // Rows toggled under the current filter, kept in view until it changes.
  const [pinned, setPinned] = useState<ReadonlySet<string>>(() => new Set())
  const setFilter = (next: CloudSkillsFilter): void => {
    sessionFilter = next
    setFilterState(next)
    setPinned(new Set())
  }
  const counts = cloudSkillsFilterCounts(groups, excluded)
  const shown = cloudSkillsFilterGroups(groups, filter, excluded, pinned)
  const empty = cloudSkillsFilterIsEmpty(shown)
  const emptyText =
    filter === 'enabled'
      ? t('cloudSkillsSync.empty.enabled', 'No enabled skills.')
      : filter === 'disabled'
        ? t('cloudSkillsSync.empty.disabled', 'No disabled skills.')
        : t('cloudSkillsSync.empty.all', 'No skills yet.')
  const toggle = (entry: CloudSkillsEntry, included: boolean): void => {
    if (filter !== 'all') {
      setPinned((current) => new Set(current).add(entry.row.key))
    }
    for (const key of cloudSkillsEntryKeys(entry)) {
      onToggleItem(key, included)
    }
  }
  return (
    <div className="space-y-1.5">
      <SettingsSegmentedControl
        size="sm"
        value={filter}
        onChange={setFilter}
        ariaLabel={t('cloudSkillsSync.filter.label', 'Show skills and commands')}
        options={[
          {
            value: 'all',
            label: t('cloudSkillsSync.filter.all', 'All {{count}}', { count: counts.all })
          },
          {
            value: 'enabled',
            label: t('cloudSkillsSync.filter.enabled', 'Enabled {{count}}', {
              count: counts.enabled
            })
          },
          {
            value: 'disabled',
            label: t('cloudSkillsSync.filter.disabled', 'Disabled {{count}}', {
              count: counts.disabled
            })
          }
        ]}
      />
      <div
        // About ten rows (320px), or 60% of the window when that is smaller; edges ruled so more reads as more.
        className="max-h-[min(20rem,60vh)] space-y-2 scrollbar-sleek overflow-y-auto overscroll-contain border-y border-border/60 py-1"
        tabIndex={0}
        role="region"
        aria-label={t('cloudSkillsSync.listLabel', 'Skills and commands')}
      >
        {empty ? (
          <p className="py-2 text-2xs text-muted-foreground">{emptyText}</p>
        ) : (
          <>
            <Group
              title={t('cloudSkillsSync.group.synced', 'Synced')}
              entries={shown.synced}
              excluded={excluded}
              disabled={disabled}
              onToggleItem={toggle}
            />
            <Group
              title={t('cloudSkillsSync.group.pending', 'Not synced yet')}
              entries={shown.pending}
              excluded={excluded}
              disabled={disabled}
              onToggleItem={toggle}
            />
            <Group
              title={t('cloudSkillsSync.group.notSynced', 'Not synced')}
              entries={shown.notSynced}
              excluded={excluded}
              disabled={disabled}
              onToggleItem={toggle}
            />
          </>
        )}
      </div>
    </div>
  )
}
