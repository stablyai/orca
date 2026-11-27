import {
  AGENT_MODEL_MAX_LENGTH,
  normalizeOptionalField
} from '../../../../agent-status/contracts/agent-status-field-normalization'
import type { ClaudeStatusLineForm } from '../../../../agent-usage/rate-limits/claude-statusline-rate-limits'

export type ClaudeStatusLineModel = {
  paneKey: string
  sessionId: string
  model: string
}

/** Read the reporting pane, session and current model from a parsed managed statusline post. */
export function readClaudeStatusLineModel({
  fields,
  payload
}: ClaudeStatusLineForm): ClaudeStatusLineModel | null {
  const paneKey =
    'paneKey' in fields && typeof fields.paneKey === 'string' ? fields.paneKey.trim() : ''
  if (!paneKey || !('session_id' in payload) || !('model' in payload)) {
    return null
  }
  const { session_id: sessionId, model } = payload
  const modelId =
    typeof model === 'object' && model !== null && 'id' in model
      ? normalizeOptionalField(model.id, AGENT_MODEL_MAX_LENGTH)
      : undefined
  if (typeof sessionId !== 'string' || !sessionId || !modelId) {
    return null
  }
  return { paneKey, sessionId, model: modelId }
}
