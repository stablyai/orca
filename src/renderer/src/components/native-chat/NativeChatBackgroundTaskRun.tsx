import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import { AgentStateDot } from '@/components/AgentStateDot'
import {
  isSettledBackgroundTaskState,
  normalizeBackgroundTaskKind,
  normalizeBackgroundTaskState
} from '../../../../shared/native-chat-background-task-row'
import type { NativeChatBackgroundTaskBlock } from '../../../../shared/native-chat-types'
import { formatBackgroundTaskTokens } from '../../../../shared/background-task-roster'
import {
  backgroundTaskStateReason,
  backgroundTaskStateWord,
  resolveBackgroundTaskName
} from './background-task-roster'
import { KIND_ICONS } from './NativeChatBackgroundTasksStatus'
import { formatNativeChatDuration } from './NativeChatWorkingStatus'

/** Render the host’s durable task state, never infer it from turn state: background work can outlive the turn that launched it. */
export function NativeChatBackgroundTaskRun({
  block
}: {
  block: NativeChatBackgroundTaskBlock
}): React.JSX.Element {
  const kind = normalizeBackgroundTaskKind(block.kind)
  const Icon = KIND_ICONS[kind]
  const state = normalizeBackgroundTaskState(block.state)
  const settled = isSettledBackgroundTaskState(state)
  // Share naming with the live strip so one task cannot appear as two different tasks.
  const label = resolveBackgroundTaskName({ id: block.taskId, kind, description: block.label })
  // Keep every attention reason, including unverifiable, consistent with the live strip.
  const reason = backgroundTaskStateReason(state)
  // Keep the provider’s outcome sentence here because its duplicate is removed from the surrounding prose.
  const sentence = block.summary?.trim() || block.error?.trim() || null
  // Show fixed duration only after settlement; live time belongs to the ticking strip.
  const duration =
    settled && block.startedAt !== undefined && block.settledAt !== undefined
      ? formatNativeChatDuration(Math.max(0, (block.settledAt - block.startedAt) / 1000))
      : null
  const meta = [
    block.tokens === undefined ? null : formatBackgroundTaskTokens(block.tokens),
    duration
  ].filter((part): part is string => part !== null)
  return (
    <div className="min-w-0 py-0.5 font-sans text-sm leading-relaxed text-chat-foreground-faint">
      <div className="flex min-h-6 min-w-0 items-center gap-1.5">
        <Icon aria-hidden="true" className="size-3.5 shrink-0 text-chat-foreground-faint" />
        <AgentStateDot state={state} size="sm" title={null} />
        <span className="min-w-0 truncate text-chat-foreground" title={label}>
          {label}
        </span>
        <span className="ml-auto shrink-0 font-sans text-xs tabular-nums text-chat-foreground-faint">
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
        <p className="mt-0.5 truncate pl-7 font-mono text-xs text-chat-foreground-faint">
          {translate('components.native-chat.backgroundTasks.outputFile', 'Output: {{value0}}', {
            value0: block.outputFile
          })}
        </p>
      ) : null}
    </div>
  )
}
