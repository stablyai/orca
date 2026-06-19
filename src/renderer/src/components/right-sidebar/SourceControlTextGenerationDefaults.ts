import { CUSTOM_AGENT_ID } from '../../../../shared/commit-message-agent-spec'
import type { ResolvedSourceControlAiGenerationParams } from '../../../../shared/source-control-ai'
import {
  setSourceControlActionDefault,
  type SourceControlTextActionId
} from '../../../../shared/source-control-ai-actions'
import type { SourceControlAiSettings } from '../../../../shared/source-control-ai-types'

export function applySourceControlTextGenerationDefaults(
  current: SourceControlAiSettings,
  actionId: SourceControlTextActionId,
  params: ResolvedSourceControlAiGenerationParams
): SourceControlAiSettings {
  if (params.agentId === CUSTOM_AGENT_ID) {
    return {
      ...current,
      ...(params.customAgentCommand !== undefined
        ? { customAgentCommand: params.customAgentCommand }
        : {}),
      actions: {
        ...current.actions,
        [actionId]: {
          ...current.actions?.[actionId],
          agentId: CUSTOM_AGENT_ID,
          commandInputTemplate: params.commandInputTemplate ?? '{basePrompt}',
          ...(params.agentArgs !== undefined ? { agentArgs: params.agentArgs } : {})
        }
      }
    }
  }
  return {
    ...current,
    actions: setSourceControlActionDefault(current.actions, actionId, {
      agentId: params.agentId,
      commandInputTemplate: params.commandInputTemplate ?? '{basePrompt}',
      ...(params.agentArgs !== undefined ? { agentArgs: params.agentArgs } : {})
    })
  }
}

export function applyCommitMessageGenerationDefaults(
  current: SourceControlAiSettings,
  _hostKey: string,
  params: ResolvedSourceControlAiGenerationParams
): SourceControlAiSettings {
  return applySourceControlTextGenerationDefaults(current, 'commitMessage', params)
}
