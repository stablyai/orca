import { ToggleGroup, ToggleGroupItem } from './ui/toggle-group'
import { translate } from '@/i18n/i18n'
import { formatNativeChatDuration } from '../../../shared/native-chat-turn-status'
import type { ResumeRunFilter, ResumeRunView } from './native-chat-resume-run-view'
import type { ResumeRunStartPhase } from './NativeChatResumeRunStatusIcon'

/** Counts and filters use the same categories so narrowing the list preserves its meaning. */

function progressText(
  counts: ResumeRunView['counts'],
  phases: readonly ResumeRunStartPhase[]
): string {
  const parts = [
    translate('auto.components.NativeChatResumeRunSummary.done', '{{value0}} of {{value1}} done', {
      value0: counts.done,
      value1: counts.total
    })
  ]
  const waitingToStart = phases.filter((phase) => phase === null).length
  const starting = phases.filter((phase) => phase === 'starting').length
  const waitingForReply = phases.filter((phase) => phase === 'ready').length
  if (starting > 0) {
    parts.push(
      translate('auto.components.NativeChatResumeRunSummary.starting', '{{value0}} starting', {
        value0: starting
      })
    )
  }
  if (waitingForReply > 0) {
    parts.push(
      translate(
        'auto.components.NativeChatResumeRunSummary.waitingForReply',
        '{{value0}} waiting for a reply',
        { value0: waitingForReply }
      )
    )
  }
  if (waitingToStart > 0) {
    parts.push(
      translate(
        'auto.components.NativeChatResumeRunSummary.waitingToStart',
        '{{value0}} waiting to start',
        { value0: waitingToStart }
      )
    )
  }
  return parts.join(' · ')
}

export function ResumeRunSummary({
  counts,
  phases,
  startedAt,
  now,
  filter,
  onFilterChange
}: {
  counts: ResumeRunView['counts']
  /** One per chat still in flight. */
  phases: readonly ResumeRunStartPhase[]
  startedAt: number
  now: number
  filter: ResumeRunFilter
  onFilterChange: (filter: ResumeRunFilter) => void
}): React.JSX.Element {
  const filters: readonly [ResumeRunFilter, string, number][] = [
    ['all', translate('auto.components.NativeChatResumeRunSummary.all', 'All'), counts.all],
    [
      'in-progress',
      translate('auto.components.NativeChatResumeRunSummary.inProgress', 'In progress'),
      counts.inProgress
    ],
    [
      'resumed',
      translate('auto.components.NativeChatResumeRunSummary.resumed', 'Resumed'),
      counts.resumed
    ],
    [
      'attention',
      translate('auto.components.NativeChatResumeRunSummary.attention', 'Need you'),
      counts.attention
    ]
  ]
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between gap-3 text-xs text-muted-foreground">
        <span className="min-w-0">{progressText(counts, phases)}</span>
        {counts.inProgress > 0 && (
          <span className="shrink-0 tabular-nums">
            {translate('auto.components.NativeChatResumeRunSummary.running', 'Running {{value0}}', {
              value0: formatNativeChatDuration((now - startedAt) / 1000)
            })}
          </span>
        )}
      </div>
      <ToggleGroup
        type="single"
        size="sm"
        variant="outline"
        value={filter}
        onValueChange={(next) => {
          // Pressing the selected filter again would clear it; the list always has one.
          if (
            next === 'all' ||
            next === 'in-progress' ||
            next === 'resumed' ||
            next === 'attention'
          ) {
            onFilterChange(next)
          }
        }}
        aria-label={translate('auto.components.NativeChatResumeRunSummary.filter', 'Show chats')}
      >
        {filters.map(([value, label, count]) => (
          <ToggleGroupItem key={value} value={value}>
            {label}
            <span className="tabular-nums text-muted-foreground">{count}</span>
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
    </div>
  )
}
