import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import { AgentStateDot } from '@/components/AgentStateDot'
import {
  isSettledBackgroundTaskState,
  normalizeBackgroundTaskKind,
  normalizeBackgroundTaskState
} from '../../../../shared/native-chat-background-task-row'
import type { NativeChatBackgroundTaskBlock } from '../../../../shared/native-chat-types'
import {
  backgroundTaskStateReason,
  backgroundTaskStateWord,
  formatBackgroundTaskTokens,
  resolveBackgroundTaskName
} from './background-task-roster'
import { KIND_ICONS } from './NativeChatBackgroundTasksStatus'
import { formatNativeChatDuration } from './NativeChatWorkingStatus'

/**
 * One background task's durable row: what it was, how it ended, and the
 * provider's own sentence about it.
 *
 * The state is drawn exactly as the journal recorded it. Turn state is NOT
 * consulted — a backgrounded task is explicitly told to outlive the turn that
 * started it, so a turn boundary is no evidence about the task. Only the host
 * that watched it can say it stopped reporting, and one does.
 */
export function NativeChatBackgroundTaskRun({
  block
}: {
  block: NativeChatBackgroundTaskBlock
}): React.JSX.Element {
  const kind = normalizeBackgroundTaskKind(block.kind)
  const Icon = KIND_ICONS[kind]
  const state = normalizeBackgroundTaskState(block.state)
  const settled = isSettledBackgroundTaskState(state)
  // Same name resolution the strip above the composer uses, so one task does
  // not read as two different things on the two surfaces.
  const label = resolveBackgroundTaskName({ id: block.taskId, kind, description: block.label })
  // Every attention state states its reason on the row, the same word the strip
  // uses; `unverifiable` ("no contact") must never be silently dropped.
  const reason = backgroundTaskStateReason(state)
  // The sentence the provider itself wrote. It is the row's whole reason for
  // existing when a task fails, and it is dropped from the prose above as the
  // block's twin, so it has to be drawn here.
  const sentence = block.summary?.trim() || block.error?.trim() || null
  // A settled row keeps a fixed duration; a live one shows none rather than a
  // frozen clock, which the strip above the composer counts for real.
  const duration =
    settled && block.startedAt !== undefined && block.settledAt !== undefined
      ? formatNativeChatDuration(Math.max(0, (block.settledAt - block.startedAt) / 1000))
      : null
  const meta = [
    block.tokens === undefined ? null : formatBackgroundTaskTokens(block.tokens),
    duration
  ].filter((part): part is string => part !== null)
  return (
    <div className="min-w-0 py-0.5 text-sm leading-relaxed text-muted-foreground">
      <div className="flex min-h-6 min-w-0 items-center gap-1.5">
        <Icon aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
        <AgentStateDot state={state} size="sm" title={null} />
        <span className={cn('min-w-0 truncate', !settled && 'text-foreground/85')}>{label}</span>
        <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
          {backgroundTaskStateWord(state)}
          {reason === null ? null : ` · ${reason}`}
          {meta.length > 0 ? ` · ${meta.join(' · ')}` : null}
        </span>
      </div>
      {sentence === null ? null : (
        <p className={cn('mt-0.5 pl-7 text-xs', state === 'blocked' && 'text-destructive')}>
          {sentence}
        </p>
      )}
      {block.outputFile ? (
        <p className="mt-0.5 truncate pl-7 font-mono text-[11px] text-muted-foreground/80">
          {translate('components.native-chat.backgroundTasks.outputFile', 'Output: {{value0}}', {
            value0: block.outputFile
          })}
        </p>
      ) : null}
    </div>
  )
}
