import {
  CUSTOM_AGENT_ID,
  getCommitMessageAgentSpec,
  getCommitMessageModel,
  isCustomAgentId,
  listCommitMessageAgentCapabilities,
  resolveCommitMessageAgentChoice
} from './commit-message-agent-spec'
import { LOCAL_COMMIT_MESSAGE_HOST_KEY } from './commit-message-host-key'
import type { GlobalSettings } from './global-settings-types'
import type { Repo } from './repo-types'
import type { TuiAgent } from './tui-agent'
import { mergeLegacyCommitMessageAiIntoSourceControlAi as mergeLegacySettings } from './source-control-ai-legacy-reconciliation'
import { projectSourceControlAiToLegacyCommitMessageAi as projectLegacySettings } from './source-control-ai-legacy-projection'
import {
  clearSourceControlAiModelChoiceForHost as clearModelChoice,
  getDiscoveredModels,
  readSourceControlAiModelChoiceForHost as readModelChoice,
  resolveThinkingLevel,
  selectPersistedModelId,
  selectSourceControlAiModelChoiceForHost as selectModelChoice
} from './source-control-ai-model-selection'
import {
  hasConfiguredSourceControlAiInstructions as hasConfiguredInstructions,
  resolveActionRecipeForTextOperation,
  resolveInstructionsFromNormalized,
  resolvePrCreationDefaults,
  resolveSourceControlActionRecipe as resolveActionRecipe,
  resolveSourceControlAiEnabled as resolveEnabled,
  resolveSourceControlAiInstructions as resolveInstructions,
  resolveSourceControlAiPrCreationDefaults as resolvePrDefaults
} from './source-control-ai-operation-policy'
import { normalizeRepoSourceControlAiOverrides as normalizeRepoOverrides } from './source-control-ai-repo-settings'
import {
  DEFAULT_SOURCE_CONTROL_AI_PR_CREATION_DEFAULTS as DEFAULT_PR_CREATION_DEFAULTS,
  getDefaultSourceControlAiSettings as getDefaultSettings,
  normalizeSourceControlAiSettings as normalizeSettings,
  sourceControlAiSettingsFromLegacy as settingsFromLegacy
} from './source-control-ai-settings'
import { hasActionAgentRecipe } from './source-control-ai-command-template'
import type {
  SourceControlAiOperation,
  SourceControlAiPrCreationDefaults
} from './source-control-ai-types'

export const DEFAULT_SOURCE_CONTROL_AI_PR_CREATION_DEFAULTS = DEFAULT_PR_CREATION_DEFAULTS

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
  | { ok: false; error: string }

type ResolveSourceControlAiInput = {
  settings: Pick<
    GlobalSettings,
    'defaultTuiAgent' | 'agentCmdOverrides' | 'commitMessageAi' | 'sourceControlAi'
  > &
    Partial<Pick<GlobalSettings, 'disabledTuiAgents'>>
  repo?: Pick<Repo, 'sourceControlAi'> | null
  operation: SourceControlAiOperation
  discoveryHostKey?: string
  prCreationProductDefaults?: SourceControlAiPrCreationDefaults
}

export type ResolveSourceControlAiPrCreationDefaultsInput = {
  settings: Pick<GlobalSettings, 'commitMessageAi' | 'sourceControlAi'>
  repo?: Pick<Repo, 'sourceControlAi'> | null
  prCreationProductDefaults?: SourceControlAiPrCreationDefaults
}

export const normalizeRepoSourceControlAiOverrides = normalizeRepoOverrides
export const getDefaultSourceControlAiSettings = getDefaultSettings
export const sourceControlAiSettingsFromLegacy = settingsFromLegacy
export const mergeLegacyCommitMessageAiIntoSourceControlAi = mergeLegacySettings
export const normalizeSourceControlAiSettings = normalizeSettings
export const readSourceControlAiModelChoiceForHost = readModelChoice
export const selectSourceControlAiModelChoiceForHost = selectModelChoice
export const clearSourceControlAiModelChoiceForHost = clearModelChoice
export const projectSourceControlAiToLegacyCommitMessageAi = projectLegacySettings
export const resolveSourceControlAiInstructions = resolveInstructions
export const hasConfiguredSourceControlAiInstructions = hasConfiguredInstructions
export const resolveSourceControlAiPrCreationDefaults = resolvePrDefaults
export const resolveSourceControlAiEnabled = resolveEnabled
export const resolveSourceControlActionRecipe = resolveActionRecipe

const OPERATION_LABEL: Record<SourceControlAiOperation, string> = {
  commitMessage: 'commit messages',
  pullRequest: 'pull request details',
  branchName: 'branch names'
}

function supportedAgentSummary(): string {
  return `Supported agents: ${listCommitMessageAgentCapabilities()
    .map((capability) => capability.label)
    .join(', ')}, or Custom command.`
}

export function resolveSourceControlAiForOperation(
  input: ResolveSourceControlAiInput
): ResolveSourceControlAiResult {
  const legacy = input.settings.commitMessageAi
  const source = normalizeSettings(input.settings.sourceControlAi, legacy)
  const repoOverrides = normalizeRepoOverrides(input.repo?.sourceControlAi)
  const prCreationDefaults = resolvePrCreationDefaults(
    source,
    repoOverrides,
    input.prCreationProductDefaults
  )
  const actionRecipe = resolveActionRecipeForTextOperation(source, repoOverrides, input.operation)
  if (!actionRecipe.commandInputTemplate.trim()) {
    return {
      ok: false,
      error: `Command template is empty for ${OPERATION_LABEL[input.operation]}.`
    }
  }
  const preferredAgent = hasActionAgentRecipe(actionRecipe) ? actionRecipe.agentId : source.agentId
  const agentChoice = resolveCommitMessageAgentChoice(
    preferredAgent,
    input.settings.defaultTuiAgent,
    input.settings.disabledTuiAgents
  )
  if (!agentChoice) {
    return {
      ok: false,
      error: `Choose a supported Source Control AI agent for this action in Settings -> Git -> Source Control AI. ${supportedAgentSummary()}`
    }
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
      return {
        ok: false,
        error: 'Custom command is empty. Add one in Settings -> Git -> Source Control AI.'
      }
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
    return {
      ok: false,
      error: `Choose a supported Source Control AI agent for this action. ${supportedAgentSummary()}`
    }
  }
  const spec = getCommitMessageAgentSpec(resolvedAgent)
  if (!spec) {
    return {
      ok: false,
      error: `Agent "${resolvedAgent}" does not support Source Control AI ${OPERATION_LABEL[input.operation]}. ${supportedAgentSummary()}`
    }
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
    return { ok: false, error: `No model is available for ${spec.label}.` }
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
