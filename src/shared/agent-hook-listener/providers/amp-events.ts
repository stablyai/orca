import {
  normalizeAgentStatusPayload,
  type ParsedAgentStatusPayload
} from '../../agent-status-types'
import { readFirstString } from '../interactive-tool'
import { readBoundedString } from '../grok-result-discovery'
import { clearPaneTurnCacheState, type HookListenerState } from '../listener-state'
import { resolvePrompt, resolveToolState } from '../prompt-fields'
import { extractToolFields, isNewTurnEvent } from '../provider-event-routing'
import { AMP_MAX_SCOPED_THREAD_CACHE_KEYS, AMP_THREAD_ID_MAX_LENGTH } from '../listener-limits'

export function normalizeAmpEvent(
  state: HookListenerState,
  eventName: unknown,
  promptText: string,
  paneKey: string,
  hookPayload: Record<string, unknown>
): ParsedAgentStatusPayload | null {
  const ampCacheKey = getAmpCacheKey(paneKey, hookPayload)
  if (eventName === 'session.start') {
    clearPaneTurnCacheState(state, ampCacheKey)
    if (ampCacheKey !== paneKey) {
      clearPaneTurnCacheState(state, paneKey)
    }
    return null
  }

  const stateName =
    eventName === 'agent.start' || eventName === 'tool.call' || eventName === 'tool.result'
      ? 'working'
      : eventName === 'agent.end'
        ? 'done'
        : null

  if (!stateName) {
    return null
  }
  if (eventName === 'agent.start') {
    state.ampCompletedCacheKeys.delete(ampCacheKey)
  } else if (
    (eventName === 'tool.call' || eventName === 'tool.result') &&
    state.ampCompletedCacheKeys.has(ampCacheKey)
  ) {
    // Why: Amp status posts are fire-and-forget, so drop stale tool events that arrive after the thread ended.
    return null
  }

  const snapshot = resolveToolState(
    state,
    ampCacheKey,
    extractToolFields('amp', eventName, hookPayload),
    { resetOnNewTurn: isNewTurnEvent('amp', eventName) }
  )

  const interrupted =
    eventName === 'agent.end' && hookPayload.status === 'cancelled' ? true : undefined
  const explicitPrompt = readFirstString(hookPayload, [
    'prompt',
    'user_prompt',
    'userPrompt',
    'initial_prompt',
    'initialPrompt',
    'user_message'
  ])
  const canUseMessageAsPrompt =
    eventName === 'agent.start' ||
    (eventName === 'agent.end' && !state.lastPromptByPaneKey.has(ampCacheKey))
  const ampPromptText = explicitPrompt ?? (canUseMessageAsPrompt ? promptText : '')

  const normalized = normalizeAgentStatusPayload({
    state: stateName,
    // Why: Amp tool/result events may use `message` for tool output; only lifecycle events may treat it as the turn prompt.
    prompt: resolvePrompt(state, ampCacheKey, ampPromptText, {
      resetOnNewTurn: isNewTurnEvent('amp', eventName)
    }),
    agentType: 'amp',
    toolName: snapshot.toolName,
    toolInput: snapshot.toolInput,
    interactivePrompt: snapshot.interactivePrompt,
    lastAssistantMessage: snapshot.lastAssistantMessage,
    interrupted
  })
  if (normalized && eventName === 'agent.end') {
    state.ampCompletedCacheKeys.add(ampCacheKey)
  }
  if (normalized) {
    pruneAmpThreadCacheKeys(state, paneKey, ampCacheKey)
  }
  return normalized
}

export function getAmpCacheKey(paneKey: string, hookPayload: Record<string, unknown>): string {
  const threadId = readBoundedString(
    hookPayload,
    ['threadId', 'threadID', 'thread_id'],
    AMP_THREAD_ID_MAX_LENGTH
  )
  // Why: Amp emits events for multiple threads per pane; cache by thread internally while keeping the visible paneKey stable.
  return threadId ? `${paneKey}\0amp:${threadId}` : paneKey
}

export function pruneAmpThreadCacheKeys(
  state: HookListenerState,
  paneKey: string,
  currentCacheKey: string
): void {
  const scopedPrefix = `${paneKey}\0amp:`
  if (!currentCacheKey.startsWith(scopedPrefix)) {
    return
  }

  const scopedKeys = new Set<string>()
  for (const key of state.lastPromptByPaneKey.keys()) {
    if (key.startsWith(scopedPrefix)) {
      scopedKeys.add(key)
    }
  }
  for (const key of state.lastToolByPaneKey.keys()) {
    if (key.startsWith(scopedPrefix)) {
      scopedKeys.add(key)
    }
  }
  for (const key of state.ampCompletedCacheKeys) {
    if (key.startsWith(scopedPrefix)) {
      scopedKeys.add(key)
    }
  }

  let overflow = scopedKeys.size - AMP_MAX_SCOPED_THREAD_CACHE_KEYS
  if (overflow <= 0) {
    return
  }

  // Why: Amp multiplexes many thread IDs through one pane; keep the current thread plus the most recent entries instead of retaining every completed thread until teardown.
  for (const key of scopedKeys) {
    if (overflow <= 0) {
      break
    }
    if (key === currentCacheKey) {
      continue
    }
    state.lastPromptByPaneKey.delete(key)
    state.lastToolByPaneKey.delete(key)
    state.ampCompletedCacheKeys.delete(key)
    overflow--
  }
}

export function hasExplicitAmpPrompt(
  eventName: unknown,
  promptText: string,
  hookPayload: Record<string, unknown>
): boolean {
  if (
    readFirstString(hookPayload, [
      'prompt',
      'user_prompt',
      'userPrompt',
      'initial_prompt',
      'initialPrompt',
      'user_message'
    ])
  ) {
    return true
  }
  // Amp tool/result `message` is output text, not a user prompt.
  return eventName === 'agent.start' && promptText.length > 0
}
