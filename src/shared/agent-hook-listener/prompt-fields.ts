import {
  isCompactContinuationUserTurnText,
  isKnownHarnessInjectedUserTurnText
} from '../harness-injected-user-turns'
import { capOpenCodeHookText } from './listener-limits'
import type { HookListenerState } from './listener-state'
import type { ToolSnapshot } from './listener-event'

// ─── Per-pane field caches + extractors ─────────────────────────────

export type ExtractedPromptText = {
  text: string
  source:
    | 'prompt'
    | 'user_prompt'
    | 'userPrompt'
    | 'initial_prompt'
    | 'initialPrompt'
    | 'user_message'
    | 'message'
    | 'role_user_text'
    | null
}

// Joins text of an Anthropic-style content-block array; returns '' when nothing textual so callers fall through to the next prompt source.
export function contentBlockArrayText(value: unknown[]): string {
  const parts: string[] = []
  for (const item of value) {
    if (typeof item === 'string') {
      parts.push(item)
      continue
    }
    if (item && typeof item === 'object') {
      const text = (item as Record<string, unknown>).text
      if (typeof text === 'string') {
        parts.push(text)
      }
    }
  }
  return parts.join(' ').replace(/\s+/g, ' ').trim()
}

export function extractPromptText(hookPayload: Record<string, unknown>): ExtractedPromptText {
  const candidateKeys = [
    'prompt',
    'user_prompt',
    'userPrompt',
    'initial_prompt',
    'initialPrompt',
    'user_message',
    'message'
  ]
  for (const key of candidateKeys) {
    const value = hookPayload[key]
    if (typeof value === 'string' && value.trim().length > 0) {
      // Why: trim so prompts match readStringField output — whitespace would otherwise leak into UI and caches.
      return { text: value.trim(), source: key as Exclude<ExtractedPromptText['source'], null> }
    }
    // Why: Kimi sends `prompt` as a content-block array, not a string; extract it for real prompt keys but skip `message` (ambiguous status field).
    if (key !== 'message' && Array.isArray(value)) {
      const text = contentBlockArrayText(value)
      if (text.length > 0) {
        return { text, source: key as Exclude<ExtractedPromptText['source'], null> }
      }
    }
  }
  // Why: OpenCode sends MessagePart { role, text } with no UserPromptSubmit; when role === 'user' the text is the prompt.
  if (hookPayload.role === 'user' && typeof hookPayload.text === 'string') {
    const trimmed = capOpenCodeHookText(hookPayload.text.trim())
    if (trimmed.length > 0) {
      return { text: trimmed, source: 'role_user_text' }
    }
  }
  return { text: '', source: null }
}

export function stripGrokUserQueryWrapper(promptText: string): string {
  const opener = '<user_query>'
  if (!promptText.startsWith(opener)) {
    return promptText
  }
  const closer = '</user_query>'
  const wrappedText = promptText.slice(opener.length)
  const text = wrappedText.endsWith(closer) ? wrappedText.slice(0, -closer.length) : wrappedText
  // Why: Grok wraps the submitted prompt in a `<user_query>` envelope; the status cache should hold the plain user text.
  return text.trim()
}

// Why: the post-compact continuation prompt has no matching Stop and would resurrect working.
export function shouldIgnoreCompactContinuationUserPromptSubmit(
  eventName: unknown,
  promptText: string
): boolean {
  return eventName === 'UserPromptSubmit' && isCompactContinuationUserTurnText(promptText)
}

export function resolvePrompt(
  state: HookListenerState,
  paneKey: string,
  promptText: string,
  options?: { resetOnNewTurn?: boolean }
): string {
  // Why: harness-injected turns fire UserPromptSubmit but aren't the user's ask — keep cached prompt; match only known tags so real <tags> still reset the turn.
  if (isKnownHarnessInjectedUserTurnText(promptText)) {
    return state.lastPromptByPaneKey.get(paneKey) ?? ''
  }
  if (options?.resetOnNewTurn) {
    state.lastPromptByPaneKey.delete(paneKey)
  }
  if (promptText) {
    state.lastPromptByPaneKey.set(paneKey, promptText)
    return promptText
  }
  return state.lastPromptByPaneKey.get(paneKey) ?? ''
}

export function resolveToolState(
  state: HookListenerState,
  paneKey: string,
  update: ToolSnapshot,
  options: { resetOnNewTurn: boolean }
): ToolSnapshot {
  if (options.resetOnNewTurn) {
    state.lastToolByPaneKey.delete(paneKey)
  }
  const previous = state.lastToolByPaneKey.get(paneKey) ?? {}
  // Why: undefined means either "no update" or "input not previewable"; extractor metadata decides whether to inherit stale input.
  const clearsUnpreviewableInput =
    update.hasToolInputField === true && update.toolInput === undefined
  const clearsUnidentifiedTool =
    update.hasToolUpdate === true &&
    update.toolName === undefined &&
    update.hasToolInputField === true
  const toolName = clearsUnidentifiedTool ? undefined : (update.toolName ?? previous.toolName)
  const toolInput =
    clearsUnpreviewableInput ||
    (update.toolName !== undefined &&
      update.toolName !== previous.toolName &&
      update.toolInput === undefined)
      ? undefined
      : (update.toolInput ?? previous.toolInput)
  const merged: ToolSnapshot = {
    toolName,
    toolInput,
    // Why: don't inherit previous.interactivePrompt — valid only for its one AskUserQuestion event; carrying it forward leaves a stale live card.
    interactivePrompt: update.interactivePrompt,
    lastAssistantMessage: update.clearLastAssistantMessage
      ? undefined
      : (update.lastAssistantMessage ?? previous.lastAssistantMessage)
  }
  state.lastToolByPaneKey.set(paneKey, merged)
  return merged
}
