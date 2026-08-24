import {
  getCommitMessageModel,
  PI_DEFAULT_MODEL_ID,
  PI_RETIRED_COPILOT_DEFAULT_MODEL_ID,
  type CommitMessageModel
} from './commit-message-agent-spec'
import type { TuiAgent } from './tui-agent'

type CommitMessagePlanModelInput = {
  agentId: TuiAgent | 'custom'
  model: string
  thinkingLevel?: string
  useConfiguredDefaultModel?: boolean
}

type CommitMessagePlanModelResult =
  | { ok: true; model: CommitMessageModel; modelId: string }
  | { ok: false; error: string }

export function resolveCommitMessagePlanModel(
  input: CommitMessagePlanModelInput,
  agentLabel: string
): CommitMessagePlanModelResult {
  if (
    input.useConfiguredDefaultModel &&
    (input.agentId !== 'pi' ||
      input.model !== PI_RETIRED_COPILOT_DEFAULT_MODEL_ID ||
      input.thinkingLevel !== undefined)
  ) {
    return { ok: false, error: 'Configured-default model intent is invalid for this request.' }
  }
  const modelId = input.useConfiguredDefaultModel ? PI_DEFAULT_MODEL_ID : input.model
  if (input.agentId === 'custom') {
    return { ok: false, error: `Model "${input.model}" is not available for ${agentLabel}.` }
  }
  const model = getCommitMessageModel(input.agentId, modelId)
  return model
    ? { ok: true, model, modelId }
    : { ok: false, error: `Model "${input.model}" is not available for ${agentLabel}.` }
}
