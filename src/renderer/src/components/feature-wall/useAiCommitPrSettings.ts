import { useCallback, useMemo, useState } from 'react'
import type { CommitMessageAiSettings } from '../../../../shared/source-control/ai/generation/commit-message-ai-types'
import {
  CUSTOM_AGENT_ID,
  getCommitMessageAgentCapability,
  isCustomAgentId,
  listCommitMessageAgentCapabilities,
  resolveCommitMessageAgentChoice
} from '../../../../shared/source-control/ai/generation/commit-message-agent-spec'
import { LOCAL_COMMIT_MESSAGE_HOST_KEY } from '../../../../shared/source-control/ai/generation/commit-message-host-key'
import { getDefaultSourceControlAiSettings } from '../../../../shared/source-control/ai/settings/source-control-ai-settings'
import { getTextGenerationModels } from '../../../../shared/source-control/ai/settings/source-control-ai-model-selection'
import { isTuiAgent } from '../../../../shared/agent-launch/catalog/tui-agent-config'
import { getAgentCatalog } from '@/lib/agent-catalog/agent-catalog'
import { useAppStore } from '@/store/index'
import type {
  AgentPickerDraft,
  AgentPickerEntry
} from '../../../../shared/agent-launch/picker/agent-launch-picker'
import type { TuiAgent } from '../../../../shared/agent-launch/catalog/tui-agent'
import { aiCommitPrPickerEntry } from './ai-commit-pr-picker'
import {
  EMPTY_COMMIT_MESSAGE_AI_SETTINGS,
  readCommitMessageAiSettings,
  resolveCommitMessageSelectedModel,
  resolveCommitMessageSelectedThinking,
  seedCommitMessageAiEnablePatch
} from './ai-commit-pr-settings-helpers'

export type AiCommitPrSettingsViewModel = {
  config: CommitMessageAiSettings
  selectPortalRoot: HTMLElement | null
  setSelectPortalHost: (node: HTMLDivElement | null) => void
  agentSelectValue: string | undefined
  activeCapability: ReturnType<typeof getCommitMessageAgentCapability>
  activeModel: ReturnType<typeof resolveCommitMessageSelectedModel> | null
  activeThinking: string | undefined
  isCustom: boolean
  unsupportedAgentLabel: string | null
  toggleAi: () => void
  onAgentChange: (newAgentId: string) => void
  pickerEntries: AgentPickerEntry[]
  onPick: (agent: TuiAgent, draft?: AgentPickerDraft) => void
  writeConfig: (patch: Partial<CommitMessageAiSettings>) => void
}

const EMPTY_SOURCE_CONTROL_AI = getDefaultSourceControlAiSettings()

export function useAiCommitPrSettings(): AiCommitPrSettingsViewModel {
  const settings = useAppStore((s) => s.settings)
  const updateSettings = useAppStore((s) => s.updateSettings)
  const [selectPortalRoot, setSelectPortalRoot] = useState<HTMLElement | null>(null)
  const setSelectPortalHost = useCallback((node: HTMLDivElement | null) => {
    setSelectPortalRoot(
      node?.closest<HTMLElement>('[data-onboarding-overlay], [data-slot="dialog-content"]') ?? node
    )
  }, [])

  const config = settings ? readCommitMessageAiSettings(settings) : EMPTY_COMMIT_MESSAGE_AI_SETTINGS
  const sourceModels = settings?.sourceControlAi?.discoveredModelsByAgent
  const sourceHostModels =
    settings?.sourceControlAi?.discoveredModelsByAgentByHost?.[LOCAL_COMMIT_MESSAGE_HOST_KEY]
  const legacyModels = config.discoveredModelsByAgent
  const legacyHostModels = config.discoveredModelsByAgentByHost?.[LOCAL_COMMIT_MESSAGE_HOST_KEY]
  const capabilities = useMemo(() => {
    const source = {
      ...EMPTY_SOURCE_CONTROL_AI,
      discoveredModelsByAgent: sourceModels,
      discoveredModelsByAgentByHost: { [LOCAL_COMMIT_MESSAGE_HOST_KEY]: sourceHostModels }
    }
    const legacy = {
      ...EMPTY_COMMIT_MESSAGE_AI_SETTINGS,
      discoveredModelsByAgent: legacyModels,
      discoveredModelsByAgentByHost: { [LOCAL_COMMIT_MESSAGE_HOST_KEY]: legacyHostModels }
    }
    return listCommitMessageAgentCapabilities().map((capability) => ({
      ...capability,
      models: getTextGenerationModels(
        capability.models,
        source,
        legacy,
        LOCAL_COMMIT_MESSAGE_HOST_KEY,
        capability.id
      )
    }))
  }, [sourceModels, sourceHostModels, legacyModels, legacyHostModels])
  const resolvedAgentId = resolveCommitMessageAgentChoice(
    config.agentId,
    settings?.defaultTuiAgent,
    settings?.disabledTuiAgents
  )
  const isCustom = isCustomAgentId(resolvedAgentId)
  const activeCapability =
    resolvedAgentId && !isCustomAgentId(resolvedAgentId)
      ? capabilities.find((capability) => capability.id === resolvedAgentId)
      : undefined
  const unsupportedConfiguredAgent =
    resolvedAgentId && !isCustom && !activeCapability ? resolvedAgentId : null
  const unsupportedConfiguredAgentLabel = unsupportedConfiguredAgent
    ? (getAgentCatalog().find((a) => a.id === unsupportedConfiguredAgent)?.label ??
      unsupportedConfiguredAgent)
    : null
  const agentSelectValue = activeCapability
    ? activeCapability.id
    : isCustom
      ? CUSTOM_AGENT_ID
      : undefined
  const activeModel = activeCapability
    ? resolveCommitMessageSelectedModel(config, activeCapability)
    : null
  const activeThinking = activeModel
    ? resolveCommitMessageSelectedThinking(config, activeModel)
    : undefined
  const unsupportedDefaultAgent =
    resolvedAgentId === null &&
    !config.agentId &&
    settings?.defaultTuiAgent &&
    settings.defaultTuiAgent !== 'blank'
      ? settings.defaultTuiAgent
      : null
  const unsupportedDefaultAgentLabel = unsupportedDefaultAgent
    ? (getAgentCatalog().find((a) => a.id === unsupportedDefaultAgent)?.label ??
      unsupportedDefaultAgent)
    : null
  const unsupportedAgentLabel = unsupportedConfiguredAgentLabel ?? unsupportedDefaultAgentLabel

  const writeConfig = (patch: Partial<CommitMessageAiSettings>): void => {
    const latest = useAppStore.getState().settings
    if (!latest) {
      return
    }
    updateSettings({ commitMessageAi: { ...readCommitMessageAiSettings(latest), ...patch } })
  }

  const toggleAi = (): void => {
    const nextEnabled = !config.enabled
    if (!nextEnabled) {
      writeConfig({ enabled: false })
      return
    }
    const seedAgentId = resolveCommitMessageAgentChoice(
      config.agentId,
      settings?.defaultTuiAgent,
      settings?.disabledTuiAgents
    )
    if (!seedAgentId) {
      writeConfig({ enabled: true, agentId: null })
      return
    }
    writeConfig(seedCommitMessageAiEnablePatch(config, seedAgentId))
  }

  const { selectedModelByAgent, selectedThinkingByModel } = config
  const pickerEntries = useMemo(
    () =>
      capabilities.map((capability) =>
        aiCommitPrPickerEntry(capability, {
          ...EMPTY_COMMIT_MESSAGE_AI_SETTINGS,
          selectedModelByAgent,
          selectedThinkingByModel
        })
      ),
    [capabilities, selectedModelByAgent, selectedThinkingByModel]
  )

  const onPick = (agent: TuiAgent, draft?: AgentPickerDraft): void => {
    const latestSettings = useAppStore.getState().settings
    if (!latestSettings) {
      return
    }
    const latest = readCommitMessageAiSettings(latestSettings)
    const capability = getCommitMessageAgentCapability(agent)
    if (!capability) {
      return
    }
    const agentChanged =
      resolveCommitMessageAgentChoice(
        latest.agentId,
        latestSettings.defaultTuiAgent,
        latestSettings.disabledTuiAgents
      ) !== agent
    const modelChanged = draft?.textChanges?.includes('model')
    const effortChanged = draft?.textChanges?.includes('effort')
    if (!agentChanged && !modelChanged && !effortChanged) {
      return
    }
    const models = getTextGenerationModels(
      capability.models,
      latestSettings.sourceControlAi ?? EMPTY_SOURCE_CONTROL_AI,
      latest,
      LOCAL_COMMIT_MESSAGE_HOST_KEY,
      agent
    )
    const modelId =
      modelChanged || effortChanged
        ? draft?.choices.model
        : resolveCommitMessageSelectedModel(latest, { ...capability, models }).id
    if (!modelId) {
      return
    }
    const selectedModelByAgent = { ...latest.selectedModelByAgent }
    if (modelChanged || !selectedModelByAgent[agent]) {
      selectedModelByAgent[agent] = modelChanged ? modelId : capability.defaultModelId
    }
    const selectedThinkingByModel = { ...latest.selectedThinkingByModel }
    const effort =
      effortChanged || (modelChanged && !selectedThinkingByModel[modelId])
        ? draft?.choices.options?.effort
        : undefined
    if (effort !== undefined) {
      selectedThinkingByModel[modelId] = effort
    } else if (!selectedThinkingByModel[modelId]) {
      const model = models.find((model) => model.id === modelId)
      if (model?.defaultThinkingLevel) {
        selectedThinkingByModel[modelId] = model.defaultThinkingLevel
      }
    }
    updateSettings({
      commitMessageAi: {
        ...latest,
        ...(agentChanged ? { agentId: agent } : {}),
        selectedModelByAgent,
        selectedThinkingByModel
      }
    })
  }

  const onAgentChange = (agentId: string): void => {
    if (isCustomAgentId(agentId)) {
      writeConfig({ agentId: CUSTOM_AGENT_ID })
    } else if (isTuiAgent(agentId)) {
      onPick(agentId)
    }
  }

  return {
    config,
    selectPortalRoot,
    setSelectPortalHost,
    agentSelectValue,
    activeCapability,
    activeModel,
    activeThinking,
    isCustom,
    unsupportedAgentLabel,
    toggleAi,
    onAgentChange,
    pickerEntries,
    onPick,
    writeConfig
  }
}
