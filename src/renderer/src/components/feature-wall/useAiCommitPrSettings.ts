import { useCallback, useState } from 'react'
import type { CommitMessageAiSettings, TuiAgent } from '../../../../shared/types'
import {
  CUSTOM_AGENT_ID,
  getCommitMessageAgentCapability,
  isCustomAgentId,
  resolveCommitMessageAgentChoice
} from '../../../../shared/commit-message-agent-spec'
import { getAgentCatalog } from '@/lib/agent-catalog'
import { useAppStore } from '@/store'
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
  onModelChange: (newModelId: string) => void
  onThinkingChange: (newLevelId: string) => void
  writeConfig: (patch: Partial<CommitMessageAiSettings>) => void
}

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
  const resolvedAgentId = resolveCommitMessageAgentChoice(
    config.agentId,
    settings?.defaultTuiAgent,
    settings?.disabledTuiAgents
  )
  const isCustom = isCustomAgentId(resolvedAgentId)
  const activeCapability =
    resolvedAgentId && !isCustomAgentId(resolvedAgentId)
      ? getCommitMessageAgentCapability(resolvedAgentId)
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
    if (!settings) {
      return
    }
    updateSettings({ commitMessageAi: { ...config, ...patch } })
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

  const onAgentChange = (newAgentId: string): void => {
    if (isCustomAgentId(newAgentId)) {
      writeConfig({ agentId: CUSTOM_AGENT_ID })
      return
    }
    const capability = getCommitMessageAgentCapability(newAgentId as TuiAgent)
    if (!capability) {
      return
    }
    const nextSelectedModelByAgent = { ...config.selectedModelByAgent }
    if (!nextSelectedModelByAgent[capability.id]) {
      nextSelectedModelByAgent[capability.id] = capability.defaultModelId
    }
    const newModel = resolveCommitMessageSelectedModel(
      { ...config, agentId: capability.id },
      capability
    )
    const nextSelectedThinkingByModel = { ...config.selectedThinkingByModel }
    if (
      newModel.thinkingLevels &&
      newModel.defaultThinkingLevel &&
      !nextSelectedThinkingByModel[newModel.id]
    ) {
      nextSelectedThinkingByModel[newModel.id] = newModel.defaultThinkingLevel
    }
    writeConfig({
      agentId: capability.id,
      selectedModelByAgent: nextSelectedModelByAgent,
      selectedThinkingByModel: nextSelectedThinkingByModel
    })
  }

  const onModelChange = (newModelId: string): void => {
    if (!activeCapability) {
      return
    }
    const model = activeCapability.models.find((m) => m.id === newModelId)
    if (!model) {
      return
    }
    const nextSelectedModelByAgent = {
      ...config.selectedModelByAgent,
      [activeCapability.id]: model.id
    }
    const nextSelectedThinkingByModel = { ...config.selectedThinkingByModel }
    if (
      model.thinkingLevels &&
      model.defaultThinkingLevel &&
      !nextSelectedThinkingByModel[model.id]
    ) {
      nextSelectedThinkingByModel[model.id] = model.defaultThinkingLevel
    }
    writeConfig({
      selectedModelByAgent: nextSelectedModelByAgent,
      selectedThinkingByModel: nextSelectedThinkingByModel
    })
  }

  const onThinkingChange = (newLevelId: string): void => {
    if (!activeModel) {
      return
    }
    writeConfig({
      selectedThinkingByModel: {
        ...config.selectedThinkingByModel,
        [activeModel.id]: newLevelId
      }
    })
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
    onModelChange,
    onThinkingChange,
    writeConfig
  }
}
