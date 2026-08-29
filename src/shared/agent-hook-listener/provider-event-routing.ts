import type { AgentHookSource } from '../agent-hook-relay'
import { isKnownHarnessInjectedUserTurnText } from '../harness-injected-user-turns'
import type { ToolSnapshot } from './listener-event'
import type { ExtractedPromptText } from './prompt-fields'
import { extractClaudeToolFields } from './providers/claude-tool-fields'
import { extractCodexToolFields } from './providers/codex-tool-fields'
import { extractGeminiToolFields } from './providers/gemini-tool-fields'
import { extractAntigravityToolFields } from './providers/antigravity-tool-fields'
import { extractAmpToolFields } from './providers/amp-tool-fields'
import { extractOpenCodeToolFields } from './providers/opencode-family-tool-fields'
import { extractCursorToolFields } from './providers/cursor-tool-fields'
import {
  extractCopilotToolFields,
  normalizeCopilotEventName
} from './providers/copilot-tool-fields'
import { extractPiToolFields } from './providers/pi-family-tool-fields'
import { extractDroidToolFields } from './providers/droid-tool-fields'
import { extractCommandCodeToolFields } from './providers/command-code-tool-fields'
import { isGrokEvent } from './provider-event-names'
import { extractGrokToolFields } from './providers/grok-tool-fields'
import { extractHermesToolFields } from './providers/hermes-tool-fields'

export function isGrokIdleNotification(message: string | undefined): boolean {
  if (!message) {
    return false
  }
  const lower = message.toLowerCase()
  return (
    lower.includes('type your message') ||
    lower.includes('enter send') ||
    lower.includes('shift-tab normal') ||
    lower.includes('ask a side question')
  )
}

/** The per-provider answer to "is this event a user-initiated new turn?". Exported so the
 *  observation stamp reuses it instead of minting a second list of event-name literals. */
export function isNewTurnEvent(source: AgentHookSource, eventName: unknown): boolean {
  // Why: exhaustive switch so a new AgentHookSource fails typecheck here instead of falling through to false.
  switch (source) {
    case 'claude':
      // Why: SessionStart lands an idle row (STA-3386) and must also drop stale
      // tool/prompt caches left by the pane's previous session.
      return eventName === 'SessionStart' || eventName === 'UserPromptSubmit'
    case 'kimi':
      // Why: Kimi Code emits Claude-compatible hook events, so UserPromptSubmit is its new-turn boundary too.
      return eventName === 'UserPromptSubmit'
    case 'codex':
      return eventName === 'SessionStart' || eventName === 'UserPromptSubmit'
    case 'gemini':
      return eventName === 'BeforeAgent'
    case 'antigravity':
      return eventName === 'PreInvocation'
    case 'amp':
      return eventName === 'agent.start'
    case 'opencode':
      return eventName === 'SessionStart'
    case 'mimo-code':
      return false
    case 'cursor':
      return eventName === 'beforeSubmitPrompt' || eventName === 'sessionStart'
    case 'pi':
    case 'omp':
    case 'prime-agent':
      return eventName === 'before_agent_start'
    case 'droid':
      return eventName === 'UserPromptSubmit'
    case 'command-code':
      return false
    case 'grok':
      return isGrokEvent(eventName, 'user_prompt_submit')
    case 'copilot': {
      const normalizedEventName = normalizeCopilotEventName(eventName)
      return normalizedEventName === 'SessionStart' || normalizedEventName === 'UserPromptSubmit'
    }
    case 'hermes':
      return eventName === 'pre_llm_call' || eventName === 'on_session_start'
    case 'devin':
      // Why: SessionStart is handled by an early return in normalizeDevinEvent, so UserPromptSubmit is Devin's real new-turn boundary here.
      return eventName === 'UserPromptSubmit'
  }
}

/**
 * The per-provider answer to "did a NEW agent process just start in this pane?".
 *
 * Deliberately not {@link isNewTurnEvent}: a turn boundary recurs inside one process, so it can
 * never order two processes that share a pane. A session boundary is emitted once per process,
 * which is what a launch-token fence needs before it hands the pane to a different token.
 *
 * Exported so the fence reuses this instead of matching a raw `SessionStart` literal — only 5 of
 * the 18 sources spell it that way, and the other 13 were stranded by it.
 */
export function isSessionStartEvent(source: AgentHookSource, eventName: unknown): boolean {
  // Why: exhaustive switch so a new AgentHookSource fails typecheck here instead of silently
  // joining the half that can never re-fence.
  switch (source) {
    case 'claude':
    case 'codex':
    case 'opencode':
    case 'droid':
    case 'devin':
      return eventName === 'SessionStart'
    case 'copilot':
      return normalizeCopilotEventName(eventName) === 'SessionStart'
    // Why cursor stays named here even though `CURSOR_EVENTS` deliberately does not subscribe to
    // it (a process-boundary hook resets the submitted-turn prompt cache): `normalizeCursorEvent`
    // does map it, so a hand-written hook config reaches this gate. An Orca-managed cursor pane is
    // re-fenced by the spawn path instead.
    case 'cursor':
      return eventName === 'sessionStart'
    case 'amp':
      return eventName === 'session.start'
    case 'pi':
    case 'prime-agent':
      return eventName === 'session_start'
    case 'grok':
      return isGrokEvent(eventName, 'session_start')
    case 'hermes':
      return eventName === 'on_session_start'
    // Why false rather than a guess: these sources emit no session boundary this codebase has
    // ever seen — Gemini CLI sends only BeforeAgent/AfterAgent/BeforeTool/AfterTool, Antigravity
    // only PreInvocation/PostInvocation, mimo-code has no SessionStart (the OpenCode-family
    // normalizer accepts it for `opencode` alone), omp is excluded from Pi's session_start
    // handling, and Command Code names no lifecycle event at all. Naming an event they do not
    // send would be a fence that never opens; their panes are re-fenced by the spawn path
    // instead, which needs no provider event.
    // Why kimi is here despite emitting Claude-compatible names: `normalizeKimiEvent` has no
    // SessionStart case, so the listener returns null for one and the relay drops it before it
    // can reach any fence — and `KIMI_HOOK_EVENTS` does not subscribe to it either. Claiming
    // the Claude spelling for kimi would be a branch no event can reach. Teaching Orca to read
    // one would need a normalizer case AND a config entry, not a line here.
    case 'kimi':
    case 'gemini':
    case 'antigravity':
    case 'mimo-code':
    case 'omp':
    case 'command-code':
      return false
  }
}

export function hasExplicitUserPrompt(
  source: AgentHookSource,
  eventName: unknown,
  extractedPrompt: ExtractedPromptText,
  resolvedPromptText: string,
  hasTranscriptPromptEvidence = false
): boolean {
  if (
    source === 'command-code' &&
    (eventName === 'PreToolUse' || eventName === 'Stop') &&
    (extractedPrompt.source !== 'message' || hasTranscriptPromptEvidence) &&
    resolvedPromptText.trim().length > 0
  ) {
    // Why: Command Code exposes the submitted prompt via its transcript, not direct hook fields; treat the transcript-backed prompt as explicit so telemetry covers real turns.
    return true
  }
  if (
    source === 'antigravity' &&
    isNewTurnEvent(source, eventName) &&
    resolvedPromptText.trim().length > 0
  ) {
    return true
  }
  if (extractedPrompt.source === 'role_user_text') {
    return (source === 'opencode' || source === 'mimo-code') && eventName === 'MessagePart'
  }
  if (extractedPrompt.text.length === 0) {
    return false
  }
  // Why: harness-injected turns aren't a user submit (no prompt-sent telemetry or permission stickiness); match only KNOWN tags so a real `<my-element>` prompt still counts and survives interrupt recovery.
  if (isKnownHarnessInjectedUserTurnText(extractedPrompt.text)) {
    return false
  }
  // Why: bare `message` fields often carry permission/status copy — may update visible status prompts but aren't proof of a user submit.
  if (extractedPrompt.source === 'message') {
    return false
  }
  if (
    extractedPrompt.source === 'user_prompt' ||
    extractedPrompt.source === 'userPrompt' ||
    extractedPrompt.source === 'user_message'
  ) {
    return isNewTurnEvent(source, eventName)
  }
  return isNewTurnEvent(source, eventName)
}

export function extractToolFields(
  source: AgentHookSource,
  eventName: unknown,
  hookPayload: Record<string, unknown>,
  options?: { grokHome?: string }
): ToolSnapshot {
  // Why: exhaustive switch so a new AgentHookSource fails typecheck here instead of silently routing through OpenCode's extractor.
  switch (source) {
    case 'claude':
    // Why: Kimi Code uses Claude's tool_name/tool_input payload fields verbatim.
    // falls through
    case 'kimi':
      return extractClaudeToolFields(eventName, hookPayload)
    case 'codex':
      return extractCodexToolFields(eventName, hookPayload)
    case 'gemini':
      return extractGeminiToolFields(eventName, hookPayload)
    case 'antigravity':
      return extractAntigravityToolFields(eventName, hookPayload)
    case 'amp':
      return extractAmpToolFields(eventName, hookPayload)
    case 'opencode':
    case 'mimo-code':
      return extractOpenCodeToolFields(eventName, hookPayload)
    case 'cursor':
      return extractCursorToolFields(eventName, hookPayload)
    case 'pi':
    case 'omp':
    case 'prime-agent':
      return extractPiToolFields(eventName, hookPayload, source)
    case 'droid':
      return extractDroidToolFields(eventName, hookPayload)
    case 'command-code':
      return extractCommandCodeToolFields(eventName, hookPayload)
    case 'grok':
      return extractGrokToolFields(eventName, hookPayload, options?.grokHome)
    case 'copilot':
      return extractCopilotToolFields(normalizeCopilotEventName(eventName), hookPayload)
    case 'hermes':
      return extractHermesToolFields(eventName, hookPayload)
    case 'devin':
      return extractClaudeToolFields(eventName, hookPayload)
  }
}
