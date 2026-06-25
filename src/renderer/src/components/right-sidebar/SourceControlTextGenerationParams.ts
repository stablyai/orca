import {
  CUSTOM_AGENT_ID,
  getCommitMessageAgentCapability,
  isCustomAgentId
} from '../../../../shared/commit-message-agent-spec'
import type { ResolvedSourceControlAiGenerationParams } from '../../../../shared/source-control-ai'
import type { GlobalSettings } from '../../../../shared/types'

export type CommitMessageGenerationAgentChoice =
  | ResolvedSourceControlAiGenerationParams['agentId']
  | ''

export function buildCommitMessageGenerationParams(args: {
  agentId: CommitMessageGenerationAgentChoice
  commandTemplate: string
  agentArgs?: string
  baseParams: ResolvedSourceControlAiGenerationParams | null
  settings: Pick<GlobalSettings, 'agentCmdOverrides'> | null | undefined
  customAgentCommand?: string
}): ResolvedSourceControlAiGenerationParams | null {
  if (!args.agentId) {
    return null
  }
  if (isCustomAgentId(args.agentId)) {
    return {
      agentId: CUSTOM_AGENT_ID,
      model: '',
      customPrompt: args.baseParams?.customPrompt,
      commandInputTemplate: args.commandTemplate,
      ...(args.agentArgs !== undefined ? { agentArgs: args.agentArgs } : {}),
      customAgentCommand: args.baseParams?.customAgentCommand ?? args.customAgentCommand ?? ''
    }
  }
  const capability = getCommitMessageAgentCapability(args.agentId)
  if (!capability) {
    return null
  }
  const sameResolvedAgent = args.baseParams?.agentId === args.agentId
  const modelId =
    sameResolvedAgent && args.baseParams?.model
      ? args.baseParams.model
      : (capability.models.find((model) => model.id === capability.defaultModelId)?.id ??
        capability.defaultModelId)
  const model = capability.models.find((candidate) => candidate.id === modelId)
  const thinkingLevel =
    sameResolvedAgent && args.baseParams?.thinkingLevel
      ? args.baseParams.thinkingLevel
      : model?.defaultThinkingLevel
  const agentCommandOverride = args.settings?.agentCmdOverrides?.[args.agentId]?.trim()
  const customAgentCommand = args.baseParams?.customAgentCommand ?? args.customAgentCommand
  return {
    agentId: args.agentId,
    model: modelId,
    ...(thinkingLevel ? { thinkingLevel } : {}),
    commandInputTemplate: args.commandTemplate,
    ...(args.agentArgs !== undefined ? { agentArgs: args.agentArgs } : {}),
    ...(customAgentCommand ? { customAgentCommand } : {}),
    ...(agentCommandOverride ? { agentCommandOverride } : {})
  }
}
