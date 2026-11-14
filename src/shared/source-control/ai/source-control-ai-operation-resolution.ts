import { isGlobalAiTextAction } from './recipes/source-control-ai-actions'
import {
  CUSTOM_AGENT_ID,
  getCommitMessageAgentSpec,
  getCommitMessageModel,
  isCustomAgentId,
  listCommitMessageAgentCapabilities,
  resolveCommitMessageAgentChoice
} from './generation/commit-message-agent-spec'
import { LOCAL_COMMIT_MESSAGE_HOST_KEY } from './generation/commit-message-host-key'
import {
  textGenerationFailure,
  type TextGenerationFailureCode,
  type TextGenerationFailureFields
} from '../../text-generation-failure-copy'
import type { GlobalSettings } from '../../global-settings-types'
import type { Repo } from '../../repo-types'
import type { TuiAgent } from '../../agent-launch/catalog/tui-agent'

import { projectSourceControlAiToLegacyCommitMessageAi as projectLegacySettings } from './settings/source-control-ai-legacy-projection'
import {
  getDiscoveredModels,
  resolveThinkingLevel,
  selectPersistedModelId
} from './settings/source-control-ai-model-selection'
import {
  resolveActionRecipeForTextOperation,
  resolveInstructionsFromNormalized,
  resolvePrCreationDefaults
} from './source-control-ai-operation-policy'
import { normalizeRepoSourceControlAiOverrides as normalizeRepoOverrides } from './settings/source-control-ai-repo-settings'
import { normalizeSourceControlAiSettings as normalizeSettings } from './settings/source-control-ai-settings'
import { hasActionAgentRecipe } from './recipes/source-control-ai-command-template'
import type {
  AiTextOperation,
  SourceControlAiModelChoice,
  SourceControlAiPrCreationDefaults
} from './settings/source-control-ai-settings-types'

export type ResolvedSourceControlAiGenerationParams = {
  agentId: TuiAgent | 'custom'
  model: string
  thinkingLevel?: string
  customPrompt?: string
  commandInputTemplate?: string
  agentArgs?: string
  customAgentCommand?: string
  agentCommandOverride?: string
}

export type ResolvedSourceControlAiOperation = {
  enabled: boolean
  params: ResolvedSourceControlAiGenerationParams
  prCreationDefaults: Required<SourceControlAiPrCreationDefaults>
}

export type ResolveSourceControlAiResult =
  | { ok: true; value: ResolvedSourceControlAiOperation }
  | ({ ok: false } & TextGenerationFailureFields)

export type SourceControlAiSettingsInput = Partial<
  Pick<
    GlobalSettings,
    | 'defaultTuiAgent'
    | 'agentCmdOverrides'
    | 'commitMessageAi'
    | 'sourceControlAi'
    | 'disabledTuiAgents'
  >
>

type ResolveSourceControlAiInput = {
  settings: SourceControlAiSettingsInput
  repo?: Pick<Repo, 'sourceControlAi'> | null
  operation: AiTextOperation
  discoveryHostKey?: string
  prCreationProductDefaults?: SourceControlAiPrCreationDefaults
}

export type ResolveSourceControlAiPrCreationDefaultsInput = {
  settings: Pick<GlobalSettings, 'commitMessageAi' | 'sourceControlAi'>
  repo?: Pick<Repo, 'sourceControlAi'> | null
  prCreationProductDefaults?: SourceControlAiPrCreationDefaults
}

const COMMAND_TEMPLATE_EMPTY = {
  commitMessage: 'commandTemplateEmptyCommitMessage',
  pullRequest: 'commandTemplateEmptyPullRequest',
  branchName: 'commandTemplateEmptyBranchName',
  conversationName: 'commandTemplateEmptyChatName',
  dictationCleanup: 'commandTemplateEmptyDictationCleanup'
} as const satisfies Record<AiTextOperation, TextGenerationFailureCode>

const AGENT_CANNOT_GENERATE = {
  commitMessage: 'agentCannotGenerateCommitMessage',
  pullRequest: 'agentCannotGeneratePullRequest',
  branchName: 'agentCannotGenerateBranchName',
  conversationName: 'agentCannotGenerateChatName',
  dictationCleanup: 'agentCannotGenerateDictationCleanup'
} as const satisfies Record<AiTextOperation, TextGenerationFailureCode>

// Each failure names the settings page where the action's agent is chosen.
const AGENT_UNSUPPORTED = {
  commitMessage: 'sourceControlAgentUnsupported',
  pullRequest: 'sourceControlAgentUnsupported',
  branchName: 'sourceControlAgentUnsupported',
  conversationName: 'chatNameAgentUnsupported',
  dictationCleanup: 'dictationCleanupAgentUnsupported'
} as const satisfies Record<AiTextOperation, TextGenerationFailureCode>

const CUSTOM_COMMAND_EMPTY = {
  commitMessage: 'sourceControlCustomCommandEmpty',
  pullRequest: 'sourceControlCustomCommandEmpty',
  branchName: 'sourceControlCustomCommandEmpty',
  conversationName: 'chatNameCustomCommandEmpty',
  // The custom command is set under Source Control AI for every action that isn't a chat name.
  dictationCleanup: 'sourceControlCustomCommandEmpty'
} as const satisfies Record<AiTextOperation, TextGenerationFailureCode>

function supportedAgentLabels(): string {
  return listCommitMessageAgentCapabilities()
    .map((capability) => capability.label)
    .join(', ')
}

function resolveFailure(
  failure: TextGenerationFailureFields
): { ok: false } & TextGenerationFailureFields {
  return { ok: false, ...failure }
}

export function resolveSourceControlAiForOperation(
  input: ResolveSourceControlAiInput
): ResolveSourceControlAiResult {
  const legacy = input.settings.commitMessageAi
  const source = normalizeSettings(input.settings.sourceControlAi, legacy)
  const repoOverrides = isGlobalAiTextAction(input.operation)
    ? null
    : normalizeRepoOverrides(input.repo?.sourceControlAi)
  const agentUnsupported = (): { ok: false } & TextGenerationFailureFields =>
    resolveFailure(
      textGenerationFailure(AGENT_UNSUPPORTED[input.operation], { agents: supportedAgentLabels() })
    )
  const prCreationDefaults = resolvePrCreationDefaults(
    source,
    repoOverrides,
    input.prCreationProductDefaults
  )
  const actionRecipe = resolveActionRecipeForTextOperation(source, repoOverrides, input.operation)
  if (!actionRecipe.commandInputTemplate.trim()) {
    return resolveFailure(textGenerationFailure(COMMAND_TEMPLATE_EMPTY[input.operation]))
  }
  const preferredAgent = hasActionAgentRecipe(actionRecipe) ? actionRecipe.agentId : source.agentId
  const agentChoice = resolveCommitMessageAgentChoice(
    preferredAgent,
    input.settings.defaultTuiAgent,
    input.settings.disabledTuiAgents
  )
  if (!agentChoice) {
    return agentUnsupported()
  }

  const customAgentCommand =
    repoOverrides?.customAgentCommand?.trim() || source.customAgentCommand.trim()
  const commonParams = {
    customPrompt: resolveInstructionsFromNormalized(
      source,
      repoOverrides,
      input.operation,
      legacy?.customPrompt
    ),
    commandInputTemplate: actionRecipe.commandInputTemplate,
    ...(actionRecipe.agentArgs !== undefined ? { agentArgs: actionRecipe.agentArgs } : {})
  }
  if (isCustomAgentId(agentChoice)) {
    if (!customAgentCommand) {
      return resolveFailure(textGenerationFailure(CUSTOM_COMMAND_EMPTY[input.operation]))
    }
    return {
      ok: true,
      value: {
        enabled: true,
        params: {
          agentId: CUSTOM_AGENT_ID,
          model: '',
          ...commonParams,
          customAgentCommand
        },
        prCreationDefaults
      }
    }
  }

  const actionAgentId = actionRecipe.agentId ?? agentChoice
  const resolvedAgent =
    actionAgentId === agentChoice
      ? agentChoice
      : resolveCommitMessageAgentChoice(
          actionAgentId,
          input.settings.defaultTuiAgent,
          input.settings.disabledTuiAgents
        )
  if (!resolvedAgent || isCustomAgentId(resolvedAgent)) {
    return agentUnsupported()
  }
  const spec = getCommitMessageAgentSpec(resolvedAgent)
  if (!spec) {
    return resolveFailure(
      textGenerationFailure(AGENT_CANNOT_GENERATE[input.operation], {
        agent: resolvedAgent,
        agents: supportedAgentLabels()
      })
    )
  }
  const hostKey = input.discoveryHostKey ?? LOCAL_COMMIT_MESSAGE_HOST_KEY
  const persistedModelId = selectPersistedModelId({
    source,
    legacy,
    repoOverrides,
    operation: input.operation,
    hostKey,
    agentId: resolvedAgent,
    defaultModelId: spec.defaultModelId
  })
  const discoveredModels = getDiscoveredModels(source, legacy, hostKey, resolvedAgent)
  const model =
    spec.models.find((candidate) => candidate.id === persistedModelId) ??
    discoveredModels.find((candidate) => candidate.id === persistedModelId) ??
    getCommitMessageModel(resolvedAgent, spec.defaultModelId)
  if (!model) {
    return resolveFailure(textGenerationFailure('noModelForAgent', { label: spec.label }))
  }
  const thinkingLevel = resolveThinkingLevel({
    model,
    source,
    legacy,
    repoOverrides,
    operation: input.operation
  })
  const agentCommandOverride = input.settings.agentCmdOverrides?.[resolvedAgent]?.trim()
  return {
    ok: true,
    value: {
      enabled: true,
      params: {
        agentId: resolvedAgent,
        model: model.id,
        thinkingLevel,
        ...commonParams,
        ...(customAgentCommand ? { customAgentCommand } : {}),
        ...(agentCommandOverride ? { agentCommandOverride } : {})
      },
      prCreationDefaults
    }
  }
}

/** Keep what a model-only clear keeps: effort stays saved per model. */
function withoutModelPick(
  choice: SourceControlAiModelChoice | undefined
): SourceControlAiModelChoice | undefined {
  return choice?.selectedThinkingByModel
    ? { selectedThinkingByModel: choice.selectedThinkingByModel }
    : undefined
}

/** Resolve what clearing the card's model runs, through the generation path and legacy mirror. */
export function resolveSourceControlAiActionModelDefault(
  input: ResolveSourceControlAiInput,
  scope: 'global' | 'repo' = 'global'
): ResolveSourceControlAiResult {
  const source = normalizeSettings(input.settings.sourceControlAi, input.settings.commitMessageAi)
  const modelOverridesByOperation = { ...source.modelOverridesByOperation }
  if (scope === 'global') {
    modelOverridesByOperation[input.operation] = withoutModelPick(
      modelOverridesByOperation[input.operation]
    )
  }
  const repoOverrides = { ...input.repo?.sourceControlAi?.modelOverridesByOperation }
  if (!isGlobalAiTextAction(input.operation)) {
    repoOverrides[input.operation] =
      scope === 'repo' ? withoutModelPick(repoOverrides[input.operation]) : undefined
  }
  const inheritedSource = { ...source, modelOverridesByOperation }
  return resolveSourceControlAiForOperation({
    ...input,
    settings: {
      ...input.settings,
      sourceControlAi: inheritedSource,
      // Refresh the legacy mirror just as clearing the commit choice in a save would.
      commitMessageAi: projectLegacySettings(inheritedSource, input.settings.commitMessageAi)
    },
    repo: {
      sourceControlAi: { ...input.repo?.sourceControlAi, modelOverridesByOperation: repoOverrides }
    }
  })
}
