import {
  CUSTOM_AGENT_ID,
  getCommitMessageAgentSpec,
  getCommitMessageModel,
  resolveCommitMessageAgentChoice
} from '../commit-message-agent-spec'
import type { GlobalSettings } from '../global-settings-types'
import type { ResolvedSourceControlAiGenerationParams } from '../source-control-ai'
import { isTuiAgent } from '../tui-agent-config'
import type { PerforceSettings } from './perforce-settings'

type Input = {
  settings: Pick<GlobalSettings, 'defaultTuiAgent' | 'agentCmdOverrides'> &
    Partial<Pick<GlobalSettings, 'disabledTuiAgents'>>
  perforce: PerforceSettings
}

export type PerforceAiParamsResult =
  | { ok: true; params: ResolvedSourceControlAiGenerationParams }
  | { ok: false; error: string }

/** Agent, model, and prompt for changelist descriptions, read only from Settings > Perforce (never Git AI Author). */
export function resolvePerforceAiParams(input: Input): PerforceAiParamsResult {
  const { perforce } = input
  const args = perforce.aiAgentArgs.trim()
  const common = {
    commandInputTemplate: '{basePrompt}',
    ...(args ? { agentArgs: args } : {})
  }
  // Why: an empty agent means "the app's default agent", not the Git commit-message agent.
  const agentId =
    perforce.aiAgentId ||
    resolveCommitMessageAgentChoice(
      null,
      input.settings.defaultTuiAgent,
      input.settings.disabledTuiAgents
    )
  if (!agentId) {
    return {
      ok: false,
      error: 'Choose an agent for changelist descriptions in Settings > Perforce.'
    }
  }
  if (agentId === CUSTOM_AGENT_ID) {
    if (!perforce.aiCustomCommand) {
      return { ok: false, error: 'Custom command is empty. Add one in Settings > Perforce.' }
    }
    return {
      ok: true,
      params: {
        agentId: CUSTOM_AGENT_ID,
        model: '',
        ...common,
        customAgentCommand: perforce.aiCustomCommand
      }
    }
  }
  const spec = isTuiAgent(agentId) ? getCommitMessageAgentSpec(agentId) : undefined
  if (!isTuiAgent(agentId) || !spec) {
    return { ok: false, error: `Agent "${agentId}" cannot write changelist descriptions.` }
  }
  const model =
    (perforce.aiModel ? getCommitMessageModel(agentId, perforce.aiModel) : undefined) ??
    getCommitMessageModel(agentId, spec.defaultModelId)
  if (!model) {
    return { ok: false, error: `No model is available for ${spec.label}.` }
  }
  const thinkingLevel = model.thinkingLevels?.some((level) => level.id === perforce.aiThinkingLevel)
    ? perforce.aiThinkingLevel
    : model.defaultThinkingLevel
  const agentCommandOverride = input.settings.agentCmdOverrides?.[agentId]?.trim()
  return {
    ok: true,
    params: {
      agentId,
      model: model.id,
      ...(thinkingLevel ? { thinkingLevel } : {}),
      ...common,
      ...(agentCommandOverride ? { agentCommandOverride } : {})
    }
  }
}
