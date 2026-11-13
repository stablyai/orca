import type { AgentSessionThreadGoalChange } from '../agent-session-thread-goal-wire'
import type { NativeChatPickerItem } from '../../native-chat/input/native-chat-picker-items'
import { applyPickerSuggestion } from '../../native-chat/input/native-chat-picker-triggers'

/** Without host goals only the provider's built-in /goal opens goal mode; a namesake keeps its invocation. */
export function structuredAgentSessionPickEntersGoalMode(
  item: NativeChatPickerItem,
  hostSetsGoals: boolean
): boolean {
  return item.kind === 'command' && item.name === 'goal' && (hostSetsGoals || item.builtin === true)
}

/** A mode chip replaces only the picked command, preserving the surrounding draft. */
export function structuredAgentSessionModePickDraft(
  draft: string,
  caret: number,
  item: NativeChatPickerItem
): { draft: string; caret: number } | null {
  const inserted = applyPickerSuggestion(draft, caret, item)
  if (!inserted.insertedToken) {
    return null
  }
  const tokenStart = inserted.caret - item.token.length - 1
  return {
    draft: inserted.draft.slice(0, tokenStart) + inserted.draft.slice(inserted.caret),
    caret: tokenStart
  }
}

const GOAL_CONTROLS: ReadonlyMap<string, AgentSessionThreadGoalChange> = new Map([
  ['pause', { kind: 'status', status: 'paused' }],
  ['resume', { kind: 'status', status: 'active' }],
  ['clear', { kind: 'clear' }]
])

/** `/goal pause|resume|clear` controls the current goal; any other text is a new objective. */
export function structuredAgentSessionGoalChange(argument: string): AgentSessionThreadGoalChange {
  return GOAL_CONTROLS.get(argument.toLowerCase()) ?? { kind: 'set', objective: argument }
}

/** Goal mode strips an optional /goal prefix instead of treating it as objective text. */
export function structuredAgentSessionGoalObjective(text: string): string {
  const goal = /^\/goal(?:\s+([\s\S]*))?$/i.exec(text.trimEnd())
  return goal ? (goal[1]?.trim() ?? '') : text.trim()
}
