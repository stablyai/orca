import { CUSTOM_AGENT_ID } from '../../../../../../shared/source-control/ai/generation/commit-message-agent-spec'
import { isOnDeviceTextGenerationId } from '../../../../../../shared/on-device-text-generation'
import type { ResolvedSourceControlAiGenerationParams } from '../../../../../../shared/source-control/ai/source-control-ai-operation-resolution'
import {
  setSourceControlActionDefault,
  type SourceControlTextActionId
} from '../../../../../../shared/source-control/ai/recipes/source-control-ai-actions'
import type { SourceControlAiSettings } from '../../../../../../shared/source-control/ai/settings/source-control-ai-settings-types'

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
      // A null per-action agent overrides the whole-setting choice and falls back to a CLI agent.
      ...(isOnDeviceTextGenerationId(params.agentId) ? {} : { agentId: params.agentId }),
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
