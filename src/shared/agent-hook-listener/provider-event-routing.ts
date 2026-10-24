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
import { extractJcodeToolFields } from './providers/jcode-tool-fields'
import { extractKiroToolFields } from './providers/kiro-tool-fields'

/** Share provider boundaries with observation stamping; avoid a second event-name list. */
export function isNewTurnEvent(source: AgentHookSource, eventName: unknown): boolean {
  // Why: exhaustive switch so a new AgentHookSource fails typecheck here instead of falling through to false.
  switch (source) {
    case 'qoder-cn':
    case 'qwen-code':
    case 'qoder':
    case 'claude':
      // SessionStart is idle but must clear previous-session tool/prompt caches (STA-3386).
      return eventName === 'SessionStart' || eventName === 'UserPromptSubmit'
    case 'codebuddy':
    case 'kimi':
      // Why: Kimi Code emits Claude-compatible hook events, so UserPromptSubmit is its new-turn boundary too.
      return eventName === 'UserPromptSubmit'
    case 'muse':
      // Muse uses Claude-compatible lifecycle events.
      return eventName === 'UserPromptSubmit'
    case 'dsh':
      // DSH SessionStart clears reused-pane caches before its first turn.
      return eventName === 'SessionStart' || eventName === 'UserPromptSubmit'
    case 'zcode':
      // SessionStart clears idle-boundary caches; UserPromptSubmit opens the actual turn.
      return eventName === 'SessionStart' || eventName === 'UserPromptSubmit'
    case 'codex':
      return eventName === 'SessionStart' || eventName === 'UserPromptSubmit'
    case 'gemini':
      return eventName === 'BeforeAgent'
    case 'antigravity':
      return eventName === 'PreInvocation'
    case 'amp':
      return eventName === 'agent.start'
    case 'opencode':
    case 'opencode2':
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
      // Devin handles SessionStart early; UserPromptSubmit is its turn boundary.
      return eventName === 'UserPromptSubmit'
    case 'jcode':
      // jcode turn_start precedes generation; session_start clears caches on its separate early path.
      return eventName === 'turn_start'
    case 'kiro':
      // Why: agentSpawn opens a fresh session in the pane, so stale tool/prompt caches go too.
      return eventName === 'agentSpawn' || eventName === 'userPromptSubmit'
  }
}

/** Only main-agent turn-end events count; reminders/session events/enrichment merely restate them. */
export function isTurnEndEvent(source: AgentHookSource, eventName: unknown): boolean {
  // Why: exhaustive switch so a new AgentHookSource fails typecheck here instead of falling through to false.
  switch (source) {
    case 'claude':
    case 'qoder':
    case 'qoder-cn':
    case 'qwen-code':
    case 'codebuddy':
    case 'kimi':
    case 'muse':
      return eventName === 'Stop' || eventName === 'StopFailure'
    case 'dsh':
    case 'zcode':
    case 'codex':
    case 'antigravity':
    case 'droid':
    case 'devin':
      return eventName === 'Stop'
    case 'gemini':
      return eventName === 'AfterAgent'
    case 'amp':
      return eventName === 'agent.end'
    case 'command-code':
      // Why: its only done event; repeats within one prompt share the transcript key, so they restate.
      return eventName === 'Stop'
    case 'cursor':
    case 'kiro':
      return eventName === 'stop'
    case 'grok':
      return isGrokEvent(eventName, 'stop', 'stop_failure', 'stop_cancelled')
    case 'copilot':
      return normalizeCopilotEventName(eventName) === 'Stop'
    case 'hermes':
      return eventName === 'post_llm_call'
    case 'jcode':
      return eventName === 'turn_end'
    case 'opencode':
    case 'opencode2':
    case 'mimo-code':
    case 'pi':
    case 'omp':
    case 'prime-agent':
      // Why: their done events are status snapshots or milestones that can repeat within one turn.
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
    // Command Code transcript evidence makes prompt submissions explicit despite absent hook fields.
    return true
  }
  if (
    source === 'antigravity' &&
    isNewTurnEvent(source, eventName) &&
    resolvedPromptText.trim().length > 0
  ) {
    return true
  }
  if (
    source === 'jcode' &&
    (eventName === 'turn_start' ||
      eventName === 'pre_tool' ||
      eventName === 'post_tool' ||
      eventName === 'turn_end') &&
    hasTranscriptPromptEvidence &&
    resolvedPromptText.trim().length > 0
  ) {
    // jcode prompts are explicit only with journal evidence.
    return true
  }
  if (extractedPrompt.source === 'role_user_text') {
    return (
      (source === 'opencode' || source === 'opencode2' || source === 'mimo-code') &&
      eventName === 'MessagePart'
    )
  }
  if (extractedPrompt.text.length === 0) {
    return false
  }
  // Known harness tags confer no user-submit telemetry/stickiness; preserve real unknown-tag prompts.
  if (isKnownHarnessInjectedUserTurnText(extractedPrompt.text)) {
    return false
  }
  // message may be status/permission text; it cannot prove submission.
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
    case 'qoder-cn':
    case 'qwen-code':
    case 'qoder':
    case 'claude':
    // Why: Kimi Code uses Claude's tool_name/tool_input payload fields verbatim.
    // falls through
    case 'codebuddy':
    case 'kimi':
    // Muse uses Claude-compatible tool fields.
    // falls through
    case 'muse':
    // DSH's own Claude-Code hook bridge emits Claude's tool_name/tool_input verbatim.
    // falls through
    case 'dsh':
    // Why: ZCode's hook runner writes Claude's `tool_name`/`tool_input`/`tool_response` aliases.
    // falls through
    case 'zcode':
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
    case 'opencode2':
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
    case 'jcode':
      return extractJcodeToolFields(eventName, hookPayload)
    case 'kiro':
      return extractKiroToolFields(eventName, hookPayload)
  }
}
