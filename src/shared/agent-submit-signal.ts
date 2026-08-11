// Why: `isNewTurnEvent` in agent-hook-listener.ts also counts session-start events, which prove a
// session exists but not that a prompt was submitted. Submit verdicts need the narrower question:
// "did this harness just tell us a user turn began?" — so the mapping lives here, on its own.

import type { AgentHookSource } from './agent-hook-relay'

export type AgentSubmitSignalKind =
  /** The harness announced the start of a user turn. */
  | 'turn-start'
  /** The harness recorded the user message but does not distinguish accepting it from starting
   *  work on it (OpenCode family). Mid-turn, such a message is queued behind the running turn. */
  | 'user-message'

export type AgentSubmitSignalEvent = {
  hookEventName?: string
  hasExplicitPrompt?: boolean
}

/** Lower-case snake form so per-source casing variants (`UserPromptSubmit`, `userPromptSubmitted`,
 *  `agent.start`) all compare against one spelling. Mirrors `normalizeHookEventName`. */
function normalizeEventName(value: string | undefined): string {
  if (typeof value !== 'string') {
    return ''
  }
  return value
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[-.\s]+/g, '_')
    .toLowerCase()
}

/** Event names that mean "a user turn just began", per harness. Session-start events are
 *  deliberately absent: a restarted CLI emits them without any prompt behind them. */
function turnStartEventNames(source: AgentHookSource): readonly string[] {
  // Why: exhaustive switch so a new AgentHookSource fails typecheck here instead of silently
  // degrading every send through that harness to `unknown`.
  switch (source) {
    case 'claude':
    case 'kimi':
    case 'codex':
    case 'droid':
    case 'devin':
    case 'grok':
      return ['user_prompt_submit']
    case 'copilot':
      return ['user_prompt_submit', 'user_prompt_submitted']
    case 'gemini':
      return ['before_agent']
    case 'antigravity':
      return ['pre_invocation']
    case 'amp':
      return ['agent_start']
    case 'cursor':
      return ['before_submit_prompt']
    case 'pi':
    case 'omp':
    case 'prime-agent':
      return ['before_agent_start']
    case 'hermes':
      // Why: pre_llm_call also fires for mid-turn continuations, so the verdict only trusts it
      // when the pane was idle or the event carries the submitted prompt (see the tracker).
      return ['pre_llm_call']
    case 'opencode':
    case 'mimo-code':
      // Why: the plugin has no turn-start event; a user MessagePart is the acceptance signal.
      return []
    case 'command-code':
      // Why: Command Code exposes prompts only by re-reading the transcript on tool events, which
      // can surface the PREVIOUS turn's prompt. That is not a submit signal, so sends into it stay
      // `unknown` rather than guessing.
      return []
  }
}

function userMessageEventNames(source: AgentHookSource): readonly string[] {
  return source === 'opencode' || source === 'mimo-code' ? ['message_part'] : []
}

/** False for harnesses that cannot tell us a turn started; sends into them can never be more than
 *  `unknown`, which is the honest answer. */
export function harnessReportsSubmitSignal(source: AgentHookSource): boolean {
  return turnStartEventNames(source).length > 0 || userMessageEventNames(source).length > 0
}

export function classifyAgentSubmitSignal(
  source: AgentHookSource,
  event: AgentSubmitSignalEvent
): AgentSubmitSignalKind | null {
  const eventName = normalizeEventName(event.hookEventName)
  if (eventName.length === 0) {
    return null
  }
  if (turnStartEventNames(source).includes(eventName)) {
    return 'turn-start'
  }
  // Why require hasExplicitPrompt: the OpenCode plugin posts a MessagePart for assistant parts too,
  // and the listener sets this flag only for a real `role: user` part.
  if (event.hasExplicitPrompt === true && userMessageEventNames(source).includes(eventName)) {
    return 'user-message'
  }
  return null
}
