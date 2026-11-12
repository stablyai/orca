// One task row's words for every transcript surface, so desktop and mobile report a task the same way.

import type { BackgroundTaskSay } from '../../background-task-copy'
import {
  backgroundTaskStateReason,
  backgroundTaskStateWord,
  formatBackgroundTaskTokens,
  resolveBackgroundTaskName
} from '../../background-task-roster'
import {
  isSettledBackgroundTaskState,
  normalizeBackgroundTaskKind,
  normalizeBackgroundTaskState
} from '../input/native-chat-background-task-row'
import type { NativeChatBackgroundTaskBlock } from '../native-chat-types'
import { formatNativeChatDuration } from './native-chat-turn-status'

/** Read the host's durable task state, never the turn's: background work can outlive the turn that launched it. */
export function nativeChatBackgroundTaskRun(
  block: NativeChatBackgroundTaskBlock,
  say: BackgroundTaskSay
) {
  const kind = normalizeBackgroundTaskKind(block.kind)
  const state = normalizeBackgroundTaskState(block.state)
  // Show fixed duration only after settlement; live time belongs to the ticking strip.
  const duration =
    isSettledBackgroundTaskState(state) &&
    block.startedAt !== undefined &&
    block.settledAt !== undefined
      ? formatNativeChatDuration(Math.max(0, (block.settledAt - block.startedAt) / 1000))
      : null
  return {
    kind,
    state,
    // Share naming with the live strip so one task cannot appear as two different tasks.
    label: resolveBackgroundTaskName({ id: block.taskId, kind, description: block.label }, say),
    status: [
      backgroundTaskStateWord(state, say),
      backgroundTaskStateReason(state, say),
      block.tokens === undefined ? null : formatBackgroundTaskTokens(block.tokens),
      duration
    ]
      .filter((part): part is string => part !== null)
      .join(' · '),
    // Keep the provider's outcome sentence here because its duplicate is removed from the surrounding prose.
    sentence: block.summary?.trim() || block.error?.trim() || null,
    output: block.outputFile ? say('outputFile', { value0: block.outputFile }) : null
  }
}
