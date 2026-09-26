import { getProviderDisplayName } from './usage-error-copy'
import type { AccountUsageEntry } from './account-usage-entry'
import { entryRateLimits } from './account-usage-entry'
import { ProviderLetterBadge, ProviderSegment } from './StatusBarProviderSegment'
import type { UsagePercentageDisplay } from '../../../../shared/usage-percentage-display'
import type { StatusBarUsageMode } from '../../../../shared/status-bar-usage-mode'

export function AccountUsageSegment({
  entry,
  compact,
  iconOnly,
  display,
  mode
}: {
  entry: AccountUsageEntry
  compact: boolean
  iconOnly: boolean
  display: UsagePercentageDisplay
  mode: StatusBarUsageMode
}): React.JSX.Element {
  const p = entryRateLimits(entry)
  return (
    <span
      className="inline-flex shrink-0 items-center gap-1.5"
      title={
        entry.label
          ? `${getProviderDisplayName(entry.provider)} · ${entry.label}`
          : getProviderDisplayName(entry.provider)
      }
      data-account-usage={entry.key}
    >
      {entry.label ? <span className="max-w-32 truncate text-xs">{entry.label}</span> : null}
      {iconOnly && !entry.label ? (
        <ProviderLetterBadge p={p} />
      ) : (
        <ProviderSegment
          p={p}
          compact={compact}
          display={display}
          mode={iconOnly ? 'compact' : mode}
        />
      )}
    </span>
  )
}
