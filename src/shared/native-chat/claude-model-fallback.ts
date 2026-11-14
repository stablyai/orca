import { MAX_CONTEXT_MODEL_ID_CHARS } from '../agent-session/agent-session-context-usage'
import { labelFromModelId } from '../model-id-label'
import type { NativeChatTextBlock } from './native-chat-types'

export const CLAUDE_MODEL_FALLBACK_FRAME_KIND = 'message:assistant:content:fallback'
export const CLAUDE_MODEL_FALLBACK_COPY = 'Claude switched models: {{from}} → {{to}}.'

export type ClaudeModelFallback = { from: string; to: string }

function modelOf(value: unknown): string | null {
  if (typeof value !== 'object' || value === null || !('model' in value)) {
    return null
  }
  const model = typeof value.model === 'string' ? value.model.trim() : ''
  return model && model.length <= MAX_CONTEXT_MODEL_ID_CHARS ? model : null
}

export function readClaudeModelFallback(value: unknown): ClaudeModelFallback | null {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('type' in value) ||
    value.type !== 'fallback'
  ) {
    return null
  }
  const from = modelOf('from' in value ? value.from : null)
  const to = modelOf('to' in value ? value.to : null)
  return from && to ? { from, to } : null
}

export function readClaudeModelFallbackFrame(
  frame: NativeChatTextBlock['providerFrame']
): ClaudeModelFallback | null {
  if (
    frame?.provider !== 'claude' ||
    frame.kind !== CLAUDE_MODEL_FALLBACK_FRAME_KIND ||
    frame.payload.truncated
  ) {
    return null
  }
  try {
    return readClaudeModelFallback(JSON.parse(frame.payload.head))
  } catch {
    return null
  }
}

export function claudeModelFallbackLabels(fallback: ClaudeModelFallback): ClaudeModelFallback {
  return { from: labelFromModelId(fallback.from), to: labelFromModelId(fallback.to) }
}

export function claudeModelFallbackText(fallback: ClaudeModelFallback): string {
  const labels = claudeModelFallbackLabels(fallback)
  return CLAUDE_MODEL_FALLBACK_COPY.replace('{{from}}', () => labels.from).replace(
    '{{to}}',
    () => labels.to
  )
}
