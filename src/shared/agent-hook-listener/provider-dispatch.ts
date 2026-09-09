import type { ParsedAgentStatusPayload } from '../agent-status-types'
import type { AgentHookSource } from '../agent-hook-relay'
import { readLastCommandCodeUserPromptEntryFromTranscript } from './command-code-transcript'
import { readGrokHomeEnvelope } from './grok-result-discovery'
import { readFirstString } from './interactive-tool'
import type { HookListenerState } from './listener-state'
import type { ExtractedPromptText } from './prompt-fields'
import { isNewTurnEvent } from './provider-event-routing'
import { readLastUserPromptFromTranscript } from './transcript-lines'
import { normalizeAntigravityEvent } from './providers/antigravity-events'
import { normalizeAmpEvent } from './providers/amp-events'
import { normalizeClaudeEvent } from './providers/claude-events'
import { normalizeCodexEvent } from './providers/codex-events'
import { normalizeGeminiEvent } from './providers/gemini-events'
import { normalizeOpenCodeFamilyEvent } from './providers/opencode-family-events'
import { normalizeCursorEvent } from './providers/cursor-events'
import { normalizePiCompatibleEvent } from './providers/pi-family-events'
import { normalizeDroidEvent } from './providers/droid-events'
import { normalizeCommandCodeEvent } from './providers/command-code-events'
import { normalizeGrokEvent } from './providers/grok-events'
import { normalizeCopilotEvent } from './providers/copilot-events'
import { normalizeHermesEvent } from './providers/hermes-events'
import { normalizeDevinEvent } from './providers/devin-events'
import { normalizeKimiEvent } from './providers/kimi-events'

export type ProviderDispatchResult = {
  payload: ParsedAgentStatusPayload | null
  resolvedPromptText: string
  promptInteractionKey?: string
  hasTranscriptPromptEvidence: boolean
}

/** Exhaustive provider routing with provider-specific transcript locality and attribution. */
export function normalizeProviderEvent(input: {
  state: HookListenerState
  source: AgentHookSource
  eventName: unknown
  promptText: string
  paneKey: string
  hookPayload: Record<string, unknown>
  envelope: Record<string, unknown>
  extractedPrompt: ExtractedPromptText
}): ProviderDispatchResult {
  const { state, source, eventName, promptText, paneKey, hookPayload, envelope, extractedPrompt } =
    input
  let resolvedPromptText = promptText
  let promptInteractionKey: string | undefined
  let hasTranscriptPromptEvidence = false
  let payload: ParsedAgentStatusPayload | null

  switch (source) {
    case 'claude':
      payload = normalizeClaudeEvent(state, eventName, promptText, paneKey, hookPayload)
      break
    case 'codex':
      payload = normalizeCodexEvent(state, eventName, promptText, paneKey, hookPayload)
      break
    case 'gemini':
      payload = normalizeGeminiEvent(state, eventName, promptText, paneKey, hookPayload)
      break
    case 'antigravity':
      if (isNewTurnEvent('antigravity', eventName)) {
        resolvedPromptText =
          promptText ||
          readLastUserPromptFromTranscript(
            readFirstString(hookPayload, ['transcriptPath', 'transcript_path'])
          ) ||
          ''
      }
      payload = normalizeAntigravityEvent(state, eventName, promptText, paneKey, hookPayload)
      break
    case 'amp':
      payload = normalizeAmpEvent(state, eventName, promptText, paneKey, hookPayload)
      break
    case 'opencode':
    case 'mimo-code': {
      if (extractedPrompt.source === 'role_user_text') {
        const messageId = readFirstString(hookPayload, ['messageID', 'messageId', 'message_id'])
        const prefix = source === 'mimo-code' ? 'mimo-code-message' : 'opencode-message'
        promptInteractionKey = messageId ? `${prefix}-${messageId}` : undefined
      }
      payload = normalizeOpenCodeFamilyEvent(
        source,
        state,
        eventName,
        promptText,
        paneKey,
        hookPayload
      )
      break
    }
    case 'cursor':
      payload = normalizeCursorEvent(state, eventName, promptText, paneKey, hookPayload)
      break
    case 'pi':
    case 'omp':
    case 'prime-agent':
      payload = normalizePiCompatibleEvent(
        state,
        source,
        eventName,
        promptText,
        paneKey,
        hookPayload
      )
      break
    case 'droid':
      payload = normalizeDroidEvent(state, eventName, promptText, paneKey, hookPayload)
      break
    case 'command-code': {
      const transcriptPrompt = readLastCommandCodeUserPromptEntryFromTranscript(
        hookPayload.transcript_path ?? hookPayload.transcriptPath
      )
      hasTranscriptPromptEvidence = transcriptPrompt !== undefined
      promptInteractionKey = transcriptPrompt?.interactionKey
      resolvedPromptText = transcriptPrompt?.text ?? ''
      if (promptText && extractedPrompt.source !== 'message') {
        resolvedPromptText = promptText
      }
      payload = normalizeCommandCodeEvent(
        state,
        eventName,
        resolvedPromptText,
        paneKey,
        hookPayload
      )
      break
    }
    case 'grok':
      payload = normalizeGrokEvent(
        state,
        eventName,
        promptText,
        paneKey,
        hookPayload,
        readGrokHomeEnvelope(envelope)
      )
      break
    case 'copilot':
      payload = normalizeCopilotEvent(state, eventName, promptText, paneKey, hookPayload)
      break
    case 'hermes':
      payload = normalizeHermesEvent(state, eventName, promptText, paneKey, hookPayload)
      break
    case 'devin':
      payload = normalizeDevinEvent(state, eventName, promptText, paneKey, hookPayload)
      break
    case 'kimi':
      payload = normalizeKimiEvent(state, eventName, promptText, paneKey, hookPayload)
      break
  }

  return { payload, resolvedPromptText, promptInteractionKey, hasTranscriptPromptEvidence }
}
