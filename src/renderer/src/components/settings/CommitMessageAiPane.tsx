/* eslint-disable max-lines -- Why: each agent setting (toggle, agent dropdown,
   model dropdown, thinking effort dropdown, custom command, custom prompt) is
   a SearchableSetting block, and splitting the pane across files would scatter
   the ~6 conditional render branches without making any of them clearer. */
import { useEffect, useMemo, useRef, useState } from 'react'
import { RefreshCw, Terminal } from 'lucide-react'
import type { GlobalSettings, TuiAgent } from '../../../../shared/types'
import type {
  SourceControlAiOperation,
  SourceControlAiSettings
} from '../../../../shared/source-control-ai-types'
import {
  clearSourceControlAiModelChoiceForHost,
  normalizeSourceControlAiSettings,
  readSourceControlAiModelChoiceForHost,
  selectSourceControlAiModelChoiceForHost
} from '../../../../shared/source-control-ai'
import {
  CUSTOM_AGENT_ID,
  getCommitMessageAgentCapability,
  isCustomAgentId,
  listCommitMessageAgentCapabilities,
  resolveCommitMessageAgentChoice,
  type CommitMessageAgentCapability,
  type CommitMessageModelCapability
} from '../../../../shared/commit-message-agent-spec'
import { CUSTOM_PROMPT_PLACEHOLDER } from '../../../../shared/commit-message-prompt'
import {
  getCommitMessageModelDiscoveryHostKeyForScope,
  LOCAL_COMMIT_MESSAGE_HOST_KEY
} from '../../../../shared/commit-message-host-key'
import { AGENT_CATALOG, AgentIcon } from '@/lib/agent-catalog'
import { getConnectionId } from '@/lib/connection-context'
import { Button } from '../ui/button'
import { Label } from '../ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select'
import {
  discoverRuntimeCommitMessageModels,
  getRuntimeGitScope
} from '../../runtime/runtime-git-client'
import { useAppStore } from '../../store'
import { useActiveWorktree } from '../../store/selectors'
import { SearchableSetting } from './SearchableSetting'
import { matchesSettingsSearch } from './settings-search'

type CommitMessageAiPaneProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void | Promise<void>
  onCustomPromptDirtyChange?: (dirty: boolean) => void
  customPromptDiscardSignal?: number
}

type SourceControlAiConfigPatch =
  | Partial<SourceControlAiSettings>
  | ((current: SourceControlAiSettings) => Partial<SourceControlAiSettings>)

type ModelDiscoveryState = {
  status: 'idle' | 'loading' | 'ready' | 'error'
  hostKey: string
  models: CommitMessageModelCapability[]
  defaultModelId?: string
  error?: string
}

const UNCONFIGURED_AGENT_SELECT_VALUE = ''
const INHERIT_MODEL_SELECT_VALUE = '__inherit__'
const COMING_SOON_COMMIT_MESSAGE_AGENTS: readonly { id: TuiAgent; label: string }[] = [
  { id: 'gemini', label: 'Gemini' }
]

function readSettings(settings: GlobalSettings): SourceControlAiSettings {
  return normalizeSourceControlAiSettings(settings.sourceControlAi, settings.commitMessageAi)
}

function agentLabel(agentId: TuiAgent, capability: CommitMessageAgentCapability): string {
  return AGENT_CATALOG.find((a) => a.id === agentId)?.label ?? capability.label
}

function readSelectedModelId(
  config: SourceControlAiSettings,
  hostKey: string,
  agentId: TuiAgent
): string | undefined {
  return readSourceControlAiModelChoiceForHost(
    {
      selectedModelByAgent: config.selectedModelByAgent,
      selectedModelByAgentByHost: config.selectedModelByAgentByHost
    },
    hostKey,
    agentId
  )
}

function resolveSelectedModel(
  config: SourceControlAiSettings,
  capability: CommitMessageAgentCapability,
  hostKey: string
): CommitMessageModelCapability {
  const persisted = readSelectedModelId(config, hostKey, capability.id)
  if (persisted) {
    const found = capability.models.find((m) => m.id === persisted)
    if (found) {
      return found
    }
  }
  // Why: defaultModelId is guaranteed to exist in provider capabilities by construction.
  return capability.models.find((m) => m.id === capability.defaultModelId) ?? capability.models[0]
}

function resolveSelectedThinking(
  config: SourceControlAiSettings,
  model: CommitMessageModelCapability
): string | undefined {
  if (!model.thinkingLevels) {
    return undefined
  }
  const persisted = config.selectedThinkingByModel[model.id]
  if (persisted && model.thinkingLevels.some((l) => l.id === persisted)) {
    return persisted
  }
  return model.defaultThinkingLevel
}

export function mergeDiscoveredModelsIntoCommitMessageConfig(
  config: SourceControlAiSettings,
  agentId: TuiAgent,
  models: CommitMessageModelCapability[],
  defaultModelId: string,
  hostKey = LOCAL_COMMIT_MESSAGE_HOST_KEY
): SourceControlAiSettings {
  const persisted = readSelectedModelId(config, hostKey, agentId)
  const nextModelId = models.some((model) => model.id === persisted) ? persisted : defaultModelId
  const selectedModelChoice =
    nextModelId && nextModelId !== persisted
      ? selectSourceControlAiModelChoiceForHost(
          {
            selectedModelByAgent: config.selectedModelByAgent,
            selectedModelByAgentByHost: config.selectedModelByAgentByHost
          },
          hostKey,
          agentId,
          nextModelId
        )
      : {
          selectedModelByAgent: config.selectedModelByAgent,
          selectedModelByAgentByHost: config.selectedModelByAgentByHost
        }
  const nextHostDiscoveredModels = {
    ...config.discoveredModelsByAgentByHost?.[hostKey],
    [agentId]: models
  }
  return {
    ...config,
    ...(hostKey === LOCAL_COMMIT_MESSAGE_HOST_KEY
      ? {
          discoveredModelsByAgent: {
            ...config.discoveredModelsByAgent,
            [agentId]: models
          },
          selectedModelByAgent:
            selectedModelChoice.selectedModelByAgent ?? config.selectedModelByAgent
        }
      : {}),
    discoveredModelsByAgentByHost: {
      ...config.discoveredModelsByAgentByHost,
      [hostKey]: nextHostDiscoveredModels
    },
    selectedModelByAgentByHost: selectedModelChoice.selectedModelByAgentByHost
  }
}

function selectModelForHost(
  config: SourceControlAiSettings,
  hostKey: string,
  agentId: TuiAgent,
  modelId: string
): Pick<SourceControlAiSettings, 'selectedModelByAgent' | 'selectedModelByAgentByHost'> {
  const choice = selectSourceControlAiModelChoiceForHost(
    {
      selectedModelByAgent: config.selectedModelByAgent,
      selectedModelByAgentByHost: config.selectedModelByAgentByHost
    },
    hostKey,
    agentId,
    modelId
  )
  return {
    selectedModelByAgent: choice.selectedModelByAgent ?? config.selectedModelByAgent,
    selectedModelByAgentByHost: choice.selectedModelByAgentByHost
  }
}

export function getCommitMessageSettingsPaneDiscoveryHostKey(
  settings: GlobalSettings,
  activeConnectionId: string | null | undefined,
  hasActiveWorktree: boolean
): string {
  const runtimeScope = hasActiveWorktree
    ? getRuntimeGitScope(settings, activeConnectionId)
    : activeConnectionId
  return getCommitMessageModelDiscoveryHostKeyForScope(runtimeScope)
}

export function CommitMessageAiPane({
  settings,
  updateSettings,
  onCustomPromptDirtyChange,
  customPromptDiscardSignal
}: CommitMessageAiPaneProps): React.JSX.Element {
  const searchQuery = useAppStore((s) => s.settingsSearchQuery)
  const activeWorktree = useActiveWorktree()
  const activeConnectionId = getConnectionId(activeWorktree?.id ?? null)
  const discoveryHostKey = getCommitMessageSettingsPaneDiscoveryHostKey(
    settings,
    activeConnectionId,
    Boolean(activeWorktree?.id)
  )
  const config = readSettings(settings)
  const latestConfigRef = useRef(config)
  latestConfigRef.current = config
  const settingsWriteQueueRef = useRef<Promise<void>>(Promise.resolve())
  const [modelDiscoveryByAgent, setModelDiscoveryByAgent] = useState<
    Partial<Record<TuiAgent, ModelDiscoveryState>>
  >({})
  const persistedCommitInstructions = config.instructionsByOperation.commitMessage ?? ''
  const persistedPullRequestInstructions = config.instructionsByOperation.pullRequest ?? ''
  const persistedBranchNameInstructions = config.instructionsByOperation.branchName ?? ''
  const [commitInstructionsDraft, setCommitInstructionsDraft] = useState(
    persistedCommitInstructions
  )
  const [pullRequestInstructionsDraft, setPullRequestInstructionsDraft] = useState(
    persistedPullRequestInstructions
  )
  const [branchNameInstructionsDraft, setBranchNameInstructionsDraft] = useState(
    persistedBranchNameInstructions
  )
  const [isSavingInstructions, setIsSavingInstructions] = useState(false)
  const persistedInstructionsRef = useRef({
    commitMessage: persistedCommitInstructions,
    pullRequest: persistedPullRequestInstructions,
    branchName: persistedBranchNameInstructions
  })
  const isCommitInstructionsDirty = commitInstructionsDraft !== persistedCommitInstructions
  const isPullRequestInstructionsDirty =
    pullRequestInstructionsDraft !== persistedPullRequestInstructions
  const isBranchNameInstructionsDirty =
    branchNameInstructionsDraft !== persistedBranchNameInstructions
  const isCustomPromptDirty =
    isCommitInstructionsDirty || isPullRequestInstructionsDirty || isBranchNameInstructionsDirty

  useEffect(() => {
    persistedInstructionsRef.current = {
      commitMessage: persistedCommitInstructions,
      pullRequest: persistedPullRequestInstructions,
      branchName: persistedBranchNameInstructions
    }
  }, [
    persistedBranchNameInstructions,
    persistedCommitInstructions,
    persistedPullRequestInstructions
  ])

  useEffect(() => {
    if (!isCommitInstructionsDirty) {
      setCommitInstructionsDraft(persistedCommitInstructions)
    }
  }, [isCommitInstructionsDirty, persistedCommitInstructions])

  useEffect(() => {
    if (!isPullRequestInstructionsDirty) {
      setPullRequestInstructionsDraft(persistedPullRequestInstructions)
    }
  }, [isPullRequestInstructionsDirty, persistedPullRequestInstructions])

  useEffect(() => {
    if (!isBranchNameInstructionsDirty) {
      setBranchNameInstructionsDraft(persistedBranchNameInstructions)
    }
  }, [isBranchNameInstructionsDirty, persistedBranchNameInstructions])

  useEffect(() => {
    setCommitInstructionsDraft(persistedInstructionsRef.current.commitMessage)
    setPullRequestInstructionsDraft(persistedInstructionsRef.current.pullRequest)
    setBranchNameInstructionsDraft(persistedInstructionsRef.current.branchName)
    // Why: parent navigation guards use this signal after the user confirms
    // they want to leave without saving the prompt draft.
  }, [customPromptDiscardSignal])

  useEffect(() => {
    onCustomPromptDirtyChange?.(isCustomPromptDirty)
  }, [isCustomPromptDirty, onCustomPromptDirtyChange])

  useEffect(
    () => () => {
      onCustomPromptDirtyChange?.(false)
    },
    [onCustomPromptDirtyChange]
  )

  const baseAgentCapabilities = useMemo(listCommitMessageAgentCapabilities, [])
  const agentCapabilities = useMemo(
    () =>
      baseAgentCapabilities.map((capability) => {
        const discovery = modelDiscoveryByAgent[capability.id]
        if (
          capability.modelSource !== 'dynamic' ||
          discovery?.status !== 'ready' ||
          discovery.hostKey !== discoveryHostKey
        ) {
          return capability
        }
        return {
          ...capability,
          models: discovery.models,
          defaultModelId: discovery.defaultModelId ?? capability.defaultModelId
        }
      }),
    [baseAgentCapabilities, discoveryHostKey, modelDiscoveryByAgent]
  )
  const resolvedAgentId = resolveCommitMessageAgentChoice(config.agentId, settings.defaultTuiAgent)
  const unsupportedSelectedAgent =
    config.agentId &&
    !isCustomAgentId(config.agentId) &&
    !getCommitMessageAgentCapability(config.agentId)
      ? config.agentId
      : null
  const activeAgentSelectValue = unsupportedSelectedAgent
    ? UNCONFIGURED_AGENT_SELECT_VALUE
    : (resolvedAgentId ?? UNCONFIGURED_AGENT_SELECT_VALUE)
  const unsupportedDefaultAgent =
    resolvedAgentId === null &&
    !config.agentId &&
    settings.defaultTuiAgent &&
    settings.defaultTuiAgent !== 'blank'
      ? settings.defaultTuiAgent
      : null
  const unsupportedDefaultAgentLabel = unsupportedDefaultAgent
    ? (AGENT_CATALOG.find((a) => a.id === unsupportedDefaultAgent)?.label ??
      unsupportedDefaultAgent)
    : null
  const unsupportedSelectedAgentIsComingSoon = COMING_SOON_COMMIT_MESSAGE_AGENTS.some(
    (agent) => agent.id === unsupportedSelectedAgent
  )
  const unsupportedSelectedAgentLabel = unsupportedSelectedAgent
    ? (COMING_SOON_COMMIT_MESSAGE_AGENTS.find((a) => a.id === unsupportedSelectedAgent)?.label ??
      AGENT_CATALOG.find((a) => a.id === unsupportedSelectedAgent)?.label ??
      unsupportedSelectedAgent)
    : null
  const isCustom = isCustomAgentId(resolvedAgentId)
  const activeAgentId = resolvedAgentId && !isCustom ? resolvedAgentId : null
  const activeCapability = activeAgentId
    ? (agentCapabilities.find((capability) => capability.id === activeAgentId) ??
      getCommitMessageAgentCapability(activeAgentId))
    : undefined
  const activeModel = activeCapability
    ? resolveSelectedModel(config, activeCapability, discoveryHostKey)
    : null
  const activeThinking = activeModel ? resolveSelectedThinking(config, activeModel) : undefined
  const rawActiveDiscovery = activeAgentId ? modelDiscoveryByAgent[activeAgentId] : undefined
  const activeDiscovery =
    rawActiveDiscovery?.hostKey === discoveryHostKey ? rawActiveDiscovery : undefined

  const writeConfig = (patch: SourceControlAiConfigPatch): Promise<void> => {
    const next = settingsWriteQueueRef.current
      .catch(() => undefined)
      .then(async () => {
        const latestSettings = useAppStore.getState().settings
        const latestConfig = latestSettings ? readSettings(latestSettings) : latestConfigRef.current
        const resolvedPatch = typeof patch === 'function' ? patch(latestConfig) : patch
        await updateSettings({ sourceControlAi: { ...latestConfig, ...resolvedPatch } })
      })
    settingsWriteQueueRef.current = next
    return next
  }

  const refreshModels = async (agentId: TuiAgent): Promise<void> => {
    const capability =
      agentCapabilities.find((candidate) => candidate.id === agentId) ??
      getCommitMessageAgentCapability(agentId)
    if (!capability || capability.modelSource !== 'dynamic') {
      return
    }
    setModelDiscoveryByAgent((prev) => ({
      ...prev,
      [agentId]: {
        status: 'loading',
        hostKey: discoveryHostKey,
        models:
          prev[agentId]?.hostKey === discoveryHostKey
            ? (prev[agentId]?.models ?? capability.models)
            : capability.models
      }
    }))
    try {
      const result = await discoverRuntimeCommitMessageModels(
        {
          settings,
          worktreeId: activeWorktree?.id,
          worktreePath: activeWorktree?.path ?? '',
          connectionId: activeConnectionId ?? undefined
        },
        agentId
      )
      if (!result.success) {
        setModelDiscoveryByAgent((prev) => ({
          ...prev,
          [agentId]: {
            status: 'error',
            hostKey: discoveryHostKey,
            models:
              prev[agentId]?.hostKey === discoveryHostKey
                ? (prev[agentId]?.models ?? capability.models)
                : capability.models,
            error: result.error
          }
        }))
        return
      }
      setModelDiscoveryByAgent((prev) => ({
        ...prev,
        [agentId]: {
          status: 'ready',
          hostKey: discoveryHostKey,
          models: result.models,
          defaultModelId: result.defaultModelId
        }
      }))
      writeConfig((current) =>
        mergeDiscoveredModelsIntoCommitMessageConfig(
          current,
          agentId,
          result.models,
          result.defaultModelId,
          discoveryHostKey
        )
      )
    } catch (error) {
      setModelDiscoveryByAgent((prev) => ({
        ...prev,
        [agentId]: {
          status: 'error',
          hostKey: discoveryHostKey,
          models:
            prev[agentId]?.hostKey === discoveryHostKey
              ? (prev[agentId]?.models ?? capability.models)
              : capability.models,
          error: error instanceof Error ? error.message : 'Failed to discover models'
        }
      }))
    }
  }

  useEffect(() => {
    if (
      !config.enabled ||
      isCustom ||
      !activeCapability ||
      activeCapability.modelSource !== 'dynamic'
    ) {
      return
    }
    const discovery = modelDiscoveryByAgent[activeCapability.id]
    if (
      discovery?.hostKey === discoveryHostKey &&
      (discovery.status === 'loading' || discovery.status === 'ready')
    ) {
      return
    }
    void refreshModels(activeCapability.id)
    // Why: auto-refresh should run once when a dynamic agent becomes active.
    // Including the discovery map would retry immediately after an error and
    // turn a visible CLI failure into a request loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    activeCapability?.id,
    activeCapability?.modelSource,
    config.enabled,
    discoveryHostKey,
    isCustom
  ])

  const onToggleEnabled = (): void => {
    const next = !config.enabled
    if (!next) {
      writeConfig({ enabled: false })
      return
    }
    // Why: when the user enables the feature for the first time, hydrate the
    // agent / model / thinking choices from their default agent when possible
    // so Generate works without maintaining a second agent preference. If the
    // user previously persisted 'custom', keep it and let them re-edit the
    // command — no implicit reset to a preset.
    const defaultTuiAgent = settings.defaultTuiAgent
    const seedAgentId = resolveCommitMessageAgentChoice(config.agentId, defaultTuiAgent)
    if (!seedAgentId) {
      writeConfig({ enabled: true, agentId: null })
      return
    }
    writeConfig((current) => {
      const currentSeedAgentId = resolveCommitMessageAgentChoice(current.agentId, defaultTuiAgent)
      const agentId = currentSeedAgentId ?? seedAgentId
      const currentCapability = isCustomAgentId(agentId)
        ? undefined
        : getCommitMessageAgentCapability(agentId)
      const seedModel = currentCapability
        ? resolveSelectedModel(current, currentCapability, discoveryHostKey)
        : null
      const seedThinking = seedModel ? resolveSelectedThinking(current, seedModel) : undefined
      const selectedModelPatch = currentCapability
        ? selectModelForHost(
            current,
            discoveryHostKey,
            currentCapability.id,
            readSelectedModelId(current, discoveryHostKey, currentCapability.id) ??
              currentCapability.defaultModelId
          )
        : {
            selectedModelByAgent: current.selectedModelByAgent,
            selectedModelByAgentByHost: current.selectedModelByAgentByHost
          }
      const nextSelectedThinkingByModel = { ...current.selectedThinkingByModel }
      if (seedModel && seedThinking && !nextSelectedThinkingByModel[seedModel.id]) {
        nextSelectedThinkingByModel[seedModel.id] = seedThinking
      }
      return {
        enabled: true,
        agentId,
        ...selectedModelPatch,
        selectedThinkingByModel: nextSelectedThinkingByModel
      }
    })
  }

  const onAgentChange = (newAgentId: string): void => {
    if (newAgentId === UNCONFIGURED_AGENT_SELECT_VALUE) {
      return
    }
    if (isCustomAgentId(newAgentId)) {
      writeConfig({ agentId: CUSTOM_AGENT_ID })
      return
    }
    const capability = getCommitMessageAgentCapability(newAgentId as TuiAgent)
    if (!capability) {
      return
    }
    writeConfig((current) => {
      const selectedModelPatch = selectModelForHost(
        current,
        discoveryHostKey,
        capability.id,
        readSelectedModelId(current, discoveryHostKey, capability.id) ?? capability.defaultModelId
      )
      const newModel = resolveSelectedModel(
        { ...current, ...selectedModelPatch, agentId: capability.id },
        capability,
        discoveryHostKey
      )
      const nextSelectedThinkingByModel = { ...current.selectedThinkingByModel }
      if (
        newModel.thinkingLevels &&
        newModel.defaultThinkingLevel &&
        !nextSelectedThinkingByModel[newModel.id]
      ) {
        nextSelectedThinkingByModel[newModel.id] = newModel.defaultThinkingLevel
      }
      return {
        agentId: capability.id,
        ...selectedModelPatch,
        selectedThinkingByModel: nextSelectedThinkingByModel
      }
    })
  }

  const onCustomCommandChange = (value: string): void => {
    writeConfig({ customAgentCommand: value })
  }

  const onModelChange = (newModelId: string): void => {
    if (!activeCapability) {
      return
    }
    const model = activeCapability.models.find((m) => m.id === newModelId)
    if (!model) {
      return
    }
    writeConfig((current) => {
      const selectedModelPatch = selectModelForHost(
        current,
        discoveryHostKey,
        activeCapability.id,
        model.id
      )
      const nextSelectedThinkingByModel = { ...current.selectedThinkingByModel }
      if (
        model.thinkingLevels &&
        model.defaultThinkingLevel &&
        !nextSelectedThinkingByModel[model.id]
      ) {
        nextSelectedThinkingByModel[model.id] = model.defaultThinkingLevel
      }
      return {
        ...selectedModelPatch,
        selectedThinkingByModel: nextSelectedThinkingByModel
      }
    })
  }

  const onThinkingChange = (newLevelId: string): void => {
    if (!activeModel) {
      return
    }
    writeConfig((current) => ({
      selectedThinkingByModel: {
        ...current.selectedThinkingByModel,
        [activeModel.id]: newLevelId
      }
    }))
  }

  const readOperationOverrideModelId = (
    operation: SourceControlAiOperation
  ): string | undefined => {
    if (!activeCapability) {
      return undefined
    }
    const choice = config.modelOverridesByOperation?.[operation]
    return readSourceControlAiModelChoiceForHost(choice, discoveryHostKey, activeCapability.id)
  }

  const onOperationModelChange = (
    operation: SourceControlAiOperation,
    newModelId: string
  ): void => {
    if (!activeCapability) {
      return
    }
    if (newModelId === INHERIT_MODEL_SELECT_VALUE) {
      writeConfig((current) => {
        const latestOverrides = { ...current.modelOverridesByOperation }
        const nextChoice = clearSourceControlAiModelChoiceForHost(
          latestOverrides[operation],
          discoveryHostKey,
          activeCapability.id
        )
        if (nextChoice) {
          latestOverrides[operation] = nextChoice
        } else {
          delete latestOverrides[operation]
        }
        return { modelOverridesByOperation: latestOverrides }
      })
      return
    }
    const model = activeCapability.models.find((candidate) => candidate.id === newModelId)
    if (!model) {
      return
    }
    writeConfig((current) => {
      const currentChoice = current.modelOverridesByOperation?.[operation]
      const nextChoice = selectSourceControlAiModelChoiceForHost(
        currentChoice,
        discoveryHostKey,
        activeCapability.id,
        model.id
      )
      if (
        model.thinkingLevels &&
        model.defaultThinkingLevel &&
        !nextChoice.selectedThinkingByModel?.[model.id]
      ) {
        nextChoice.selectedThinkingByModel = {
          ...nextChoice.selectedThinkingByModel,
          [model.id]: model.defaultThinkingLevel
        }
      }
      return {
        modelOverridesByOperation: {
          ...current.modelOverridesByOperation,
          [operation]: nextChoice
        }
      }
    })
  }

  const onOperationThinkingChange = (
    operation: SourceControlAiOperation,
    modelId: string,
    newLevelId: string
  ): void => {
    writeConfig((current) => ({
      modelOverridesByOperation: {
        ...current.modelOverridesByOperation,
        [operation]: {
          ...current.modelOverridesByOperation?.[operation],
          selectedThinkingByModel: {
            ...current.modelOverridesByOperation?.[operation]?.selectedThinkingByModel,
            [modelId]: newLevelId
          }
        }
      }
    }))
  }

  const onSaveInstructions = async (operation: SourceControlAiOperation): Promise<void> => {
    const draft =
      operation === 'commitMessage'
        ? commitInstructionsDraft
        : operation === 'pullRequest'
          ? pullRequestInstructionsDraft
          : branchNameInstructionsDraft
    const dirty =
      operation === 'commitMessage'
        ? isCommitInstructionsDirty
        : operation === 'pullRequest'
          ? isPullRequestInstructionsDirty
          : isBranchNameInstructionsDirty
    if (!dirty || isSavingInstructions) {
      return
    }
    setIsSavingInstructions(true)
    try {
      await writeConfig((current) => ({
        instructionsByOperation: {
          ...current.instructionsByOperation,
          [operation]: draft
        }
      }))
    } finally {
      setIsSavingInstructions(false)
    }
  }

  const onDiscardInstructions = (operation: SourceControlAiOperation): void => {
    if (operation === 'commitMessage') {
      setCommitInstructionsDraft(persistedCommitInstructions)
      return
    }
    if (operation === 'branchName') {
      setBranchNameInstructionsDraft(persistedBranchNameInstructions)
      return
    }
    setPullRequestInstructionsDraft(persistedPullRequestInstructions)
  }

  const onPrDefaultChange = (
    key: keyof NonNullable<SourceControlAiSettings['prCreationDefaults']>,
    value: boolean
  ): void => {
    writeConfig((current) => ({
      prCreationDefaults: {
        ...current.prCreationDefaults,
        [key]: value
      }
    }))
  }

  const sections: React.ReactNode[] = []

  if (
    matchesSettingsSearch(searchQuery, {
      title: 'Enable Source Control AI',
      description:
        'Adds AI generation to Source Control commit, pull request, and branch-name flows.',
      keywords: ['ai', 'commit', 'message', 'generate', 'agent', 'enabled']
    })
  ) {
    sections.push(
      <SearchableSetting
        key="enabled"
        title="Enable Source Control AI"
        description="Adds AI generation to Source Control commit, pull request, and branch-name flows."
        keywords={['ai', 'commit', 'message', 'generate', 'agent', 'enabled']}
        className="flex items-center justify-between gap-4 py-2"
      >
        <div className="space-y-0.5">
          <Label>Enable Source Control AI</Label>
          <p className="text-xs text-muted-foreground">
            Adds Generate controls for commit messages and pull request details. Runs the selected
            agent CLI where the worktree is hosted.
          </p>
        </div>
        <button
          role="switch"
          aria-checked={config.enabled}
          onClick={onToggleEnabled}
          className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border border-transparent transition-colors ${
            config.enabled ? 'bg-foreground' : 'bg-muted-foreground/30'
          }`}
        >
          <span
            className={`pointer-events-none block size-3.5 rounded-full bg-background shadow-sm transition-transform ${
              config.enabled ? 'translate-x-4' : 'translate-x-0.5'
            }`}
          />
        </button>
      </SearchableSetting>
    )
  }

  if (
    config.enabled &&
    matchesSettingsSearch(searchQuery, {
      title: 'Agent',
      description: 'Which agent to invoke for Source Control text generation.',
      keywords: ['agent', 'claude', 'codex', 'opencode', 'gemini', 'cursor']
    })
  ) {
    sections.push(
      <SearchableSetting
        key="agent"
        title="Agent"
        description="Which agent to invoke for Source Control text generation."
        keywords={['agent', 'claude', 'codex', 'opencode', 'gemini', 'cursor']}
        className="flex items-center justify-between gap-4 py-2"
      >
        <div className="space-y-0.5">
          <Label>Agent</Label>
          <p className="text-xs text-muted-foreground">
            Orca invokes this CLI in the background for commit messages and pull request details. It
            must be installed where the worktree is hosted - your computer for local worktrees, or
            the SSH host for remote ones.
          </p>
        </div>
        <div className="flex flex-col items-end gap-1">
          <Select value={activeAgentSelectValue} onValueChange={onAgentChange}>
            <SelectTrigger size="sm" className="h-8 w-[260px] shrink-0 text-xs">
              <SelectValue placeholder="Not configured" />
            </SelectTrigger>
            <SelectContent>
              {agentCapabilities.map((capability) => {
                const id = capability.id
                return (
                  <SelectItem key={id} value={id} className="cursor-pointer">
                    <span className="flex items-center gap-2">
                      <AgentIcon agent={id} size={14} />
                      <span>{agentLabel(id, capability)}</span>
                    </span>
                  </SelectItem>
                )
              })}
              {COMING_SOON_COMMIT_MESSAGE_AGENTS.filter(
                (agent) => !agentCapabilities.some((capability) => capability.id === agent.id)
              ).map((agent) => (
                <SelectItem key={agent.id} value={agent.id} disabled className="cursor-not-allowed">
                  <span className="flex items-center gap-2">
                    <AgentIcon agent={agent.id} size={14} />
                    <span>{agent.label}</span>
                    <span className="text-[11px] text-muted-foreground">Coming soon</span>
                  </span>
                </SelectItem>
              ))}
              <SelectItem value={CUSTOM_AGENT_ID} className="cursor-pointer">
                <span className="flex items-center gap-2">
                  <Terminal className="size-3.5" />
                  <span>Custom</span>
                </span>
              </SelectItem>
            </SelectContent>
          </Select>
          {unsupportedDefaultAgentLabel ? (
            <p className="max-w-[260px] text-right text-[11px] text-muted-foreground">
              Your default agent is {unsupportedDefaultAgentLabel}, which does not support Source
              Control AI yet. Choose a supported agent or Custom.
            </p>
          ) : null}
          {unsupportedSelectedAgentLabel ? (
            <p className="max-w-[260px] text-right text-[11px] text-muted-foreground">
              {unsupportedSelectedAgentIsComingSoon
                ? `${unsupportedSelectedAgentLabel} Source Control AI is coming soon.`
                : `${unsupportedSelectedAgentLabel} does not support Source Control AI yet.`}{' '}
              Choose a supported agent or Custom.
            </p>
          ) : null}
        </div>
      </SearchableSetting>
    )
  }

  if (
    config.enabled &&
    isCustom &&
    matchesSettingsSearch(searchQuery, {
      title: 'Custom command',
      description: 'Command line Orca runs to generate source-control text.',
      keywords: ['custom', 'command', 'cli', 'binary', 'prompt', 'placeholder']
    })
  ) {
    sections.push(
      <SearchableSetting
        key="custom-command"
        title="Custom command"
        description="Command line Orca runs to generate source-control text."
        keywords={['custom', 'command', 'cli', 'binary', 'prompt', 'placeholder']}
        className="space-y-2 py-2"
      >
        <div className="space-y-0.5">
          <Label htmlFor="commit-message-ai-custom-command">Custom command</Label>
          <p className="text-xs text-muted-foreground">
            Use{' '}
            <code className="rounded bg-muted/60 px-1 py-0.5 text-[10px]">
              {CUSTOM_PROMPT_PLACEHOLDER}
            </code>{' '}
            where the prompt should be substituted (passed as a single argument). Omit it and the
            prompt is piped via stdin instead - useful for CLIs like{' '}
            <code className="rounded bg-muted/60 px-1 py-0.5 text-[10px]">claude -p</code>. Quoting
            is for grouping arguments only; we never invoke a shell, so{' '}
            <code className="rounded bg-muted/60 px-1 py-0.5 text-[10px]">$VAR</code> and backticks
            are not expanded.
          </p>
        </div>
        <input
          id="commit-message-ai-custom-command"
          type="text"
          spellCheck={false}
          autoCorrect="off"
          autoCapitalize="off"
          value={config.customAgentCommand}
          onChange={(e) => onCustomCommandChange(e.target.value)}
          placeholder={`e.g. ollama run llama3.1 ${CUSTOM_PROMPT_PLACEHOLDER}`}
          className="w-full rounded-md border border-border bg-background px-2 py-1.5 font-mono text-xs text-foreground outline-none placeholder:text-muted-foreground/70 focus-visible:ring-1 focus-visible:ring-ring"
        />
      </SearchableSetting>
    )
  }

  if (
    config.enabled &&
    activeCapability &&
    activeModel &&
    matchesSettingsSearch(searchQuery, {
      title: 'Default model',
      description: 'Which model Source Control AI uses unless an operation override exists.',
      keywords: ['model', 'haiku', 'sonnet', 'opus', 'gpt']
    })
  ) {
    sections.push(
      <SearchableSetting
        key="model"
        title="Default model"
        description="Which model Source Control AI uses unless an operation override exists."
        keywords={['model', 'haiku', 'sonnet', 'opus', 'gpt']}
        className="flex items-center justify-between gap-4 py-2"
      >
        <div className="space-y-0.5">
          <Label>Default model</Label>
          <p className="text-xs text-muted-foreground">
            {activeCapability.modelSource === 'dynamic'
              ? 'Refreshes from the selected CLI when the CLI exposes model discovery.'
              : 'This agent does not expose model discovery, so Orca uses a manual catalog.'}
          </p>
          {activeDiscovery?.status === 'error' && (
            <p className="text-xs text-destructive">{activeDiscovery.error}</p>
          )}
        </div>
        <div className="flex items-center gap-2">
          {activeCapability.modelSource === 'dynamic' && (
            <button
              type="button"
              onClick={() => void refreshModels(activeCapability.id)}
              disabled={activeDiscovery?.status === 'loading'}
              title="Refresh models"
              aria-label="Refresh models"
              className="inline-flex size-8 items-center justify-center rounded-md border border-border text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
            >
              <RefreshCw
                className={`size-3.5 ${activeDiscovery?.status === 'loading' ? 'animate-spin' : ''}`}
              />
            </button>
          )}
          <Select value={activeModel.id} onValueChange={onModelChange}>
            <SelectTrigger size="sm" className="h-8 w-[260px] shrink-0 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {activeCapability.models.map((m) => (
                <SelectItem key={m.id} value={m.id} className="cursor-pointer">
                  {m.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </SearchableSetting>
    )
  }

  if (
    config.enabled &&
    activeModel?.thinkingLevels &&
    activeThinking &&
    matchesSettingsSearch(searchQuery, {
      title: 'Thinking effort',
      description: 'Reasoning effort level for the selected model. Higher levels are slower.',
      keywords: ['thinking', 'effort', 'reasoning']
    })
  ) {
    sections.push(
      <SearchableSetting
        key="thinking"
        title="Thinking effort"
        description="Reasoning effort level for the selected model. Higher levels are slower."
        keywords={['thinking', 'effort', 'reasoning']}
        className="flex items-center justify-between gap-4 py-2"
      >
        <div className="space-y-0.5">
          <Label>Thinking effort</Label>
          <p className="text-xs text-muted-foreground">
            Higher effort produces more careful messages but takes longer and costs more tokens.
          </p>
        </div>
        <Select value={activeThinking} onValueChange={onThinkingChange}>
          <SelectTrigger size="sm" className="h-8 text-xs w-[160px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {activeModel.thinkingLevels.map((level) => (
              <SelectItem key={level.id} value={level.id} className="cursor-pointer">
                {level.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </SearchableSetting>
    )
  }

  if (
    config.enabled &&
    activeCapability &&
    activeModel &&
    matchesSettingsSearch(searchQuery, {
      title: 'Advanced model overrides',
      description:
        'Optional per-operation model choices for commit messages, PR details, and branch names.',
      keywords: ['model', 'override', 'commit', 'pull request', 'pr', 'thinking']
    })
  ) {
    const operationRows: {
      operation: SourceControlAiOperation
      label: string
      description: string
    }[] = [
      {
        operation: 'commitMessage',
        label: 'Commit message model',
        description: 'Use a different model for commit message generation.'
      },
      {
        operation: 'pullRequest',
        label: 'PR details model',
        description: 'Use a different model for pull request title and description generation.'
      },
      {
        operation: 'branchName',
        label: 'Branch name model',
        description: 'Use a different model for branch name generation.'
      }
    ]
    sections.push(
      <SearchableSetting
        key="model-overrides"
        title="Advanced model overrides"
        description="Optional per-operation model choices for commit messages, PR details, and branch names."
        keywords={['model', 'override', 'commit', 'pull request', 'pr', 'thinking']}
        className="space-y-3 px-1 py-2"
      >
        <div className="space-y-0.5">
          <Label>Advanced model overrides</Label>
          <p className="text-xs text-muted-foreground">
            Leave these inherited unless commit messages, PR details, or branch names need different
            model behavior.
          </p>
        </div>
        <div className="space-y-3">
          {operationRows.map((row) => {
            const overrideModelId = readOperationOverrideModelId(row.operation)
            const selectedModel = overrideModelId
              ? activeCapability.models.find((model) => model.id === overrideModelId)
              : undefined
            const selectedThinking = selectedModel?.thinkingLevels?.some(
              (level) =>
                level.id ===
                config.modelOverridesByOperation?.[row.operation]?.selectedThinkingByModel?.[
                  selectedModel.id
                ]
            )
              ? config.modelOverridesByOperation?.[row.operation]?.selectedThinkingByModel?.[
                  selectedModel.id
                ]
              : selectedModel?.defaultThinkingLevel
            return (
              <div
                key={row.operation}
                className="space-y-2 rounded-md border border-border px-3 py-2"
              >
                <div className="flex items-start justify-between gap-4">
                  <div className="space-y-0.5">
                    <p className="text-xs font-medium text-foreground">{row.label}</p>
                    <p className="text-[11px] text-muted-foreground">{row.description}</p>
                  </div>
                  <Select
                    value={overrideModelId ?? INHERIT_MODEL_SELECT_VALUE}
                    onValueChange={(value) => onOperationModelChange(row.operation, value)}
                  >
                    <SelectTrigger size="sm" className="h-8 w-[220px] shrink-0 text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={INHERIT_MODEL_SELECT_VALUE} className="cursor-pointer">
                        Use default model
                      </SelectItem>
                      {activeCapability.models.map((model) => (
                        <SelectItem key={model.id} value={model.id} className="cursor-pointer">
                          {model.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                {selectedModel?.thinkingLevels && selectedThinking ? (
                  <div className="flex items-center justify-end gap-2">
                    <span className="text-[11px] text-muted-foreground">Thinking</span>
                    <Select
                      value={selectedThinking}
                      onValueChange={(value) =>
                        onOperationThinkingChange(row.operation, selectedModel.id, value)
                      }
                    >
                      <SelectTrigger size="sm" className="h-7 w-[150px] text-xs">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {selectedModel.thinkingLevels.map((level) => (
                          <SelectItem key={level.id} value={level.id} className="cursor-pointer">
                            {level.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                ) : null}
              </div>
            )
          })}
        </div>
      </SearchableSetting>
    )
  }

  if (
    (config.enabled || isCommitInstructionsDirty) &&
    (isCommitInstructionsDirty ||
      matchesSettingsSearch(searchQuery, {
        title: 'Commit message instructions',
        description: 'Optional instructions appended only to commit-message prompts.',
        keywords: ['prompt', 'instructions', 'conventional commits', 'gitmoji', 'style']
      }))
  ) {
    sections.push(
      <SearchableSetting
        key="commit-instructions"
        title="Commit message instructions"
        description="Optional instructions appended only to commit-message prompts."
        keywords={['prompt', 'instructions', 'conventional commits', 'gitmoji', 'style']}
        forceVisible={isCommitInstructionsDirty}
        className="space-y-2 px-1 py-2"
      >
        <div className="space-y-0.5">
          <Label htmlFor="source-control-ai-commit-instructions">Commit message instructions</Label>
          <p className="text-xs text-muted-foreground">
            Appended only when generating commit messages. Use this for Conventional Commits, ticket
            prefixes, or any other commit style your team prefers.
          </p>
        </div>
        <textarea
          id="source-control-ai-commit-instructions"
          rows={4}
          value={commitInstructionsDraft}
          onChange={(e) => setCommitInstructionsDraft(e.target.value)}
          placeholder="Use Conventional Commits format (feat:, fix:, ...). Reference the ticket key when present."
          className="w-full resize-y rounded-md border border-border bg-background px-2 py-1.5 text-xs text-foreground outline-none placeholder:text-muted-foreground/70 focus-visible:ring-1 focus-visible:ring-ring"
        />
        <div className="flex items-center justify-between gap-3">
          <p className="text-[11px] text-muted-foreground">
            {isCommitInstructionsDirty ? 'Unsaved changes' : 'Saved'}
          </p>
          <div className="flex items-center gap-2">
            {isCommitInstructionsDirty ? (
              <Button
                type="button"
                variant="ghost"
                size="xs"
                onClick={() => onDiscardInstructions('commitMessage')}
                disabled={isSavingInstructions}
              >
                Discard
              </Button>
            ) : null}
            <Button
              type="button"
              variant="secondary"
              size="xs"
              onClick={() => void onSaveInstructions('commitMessage')}
              disabled={!isCommitInstructionsDirty || isSavingInstructions}
            >
              {isSavingInstructions ? 'Saving...' : 'Save'}
            </Button>
          </div>
        </div>
      </SearchableSetting>
    )
  }

  if (
    (config.enabled || isPullRequestInstructionsDirty) &&
    (isPullRequestInstructionsDirty ||
      matchesSettingsSearch(searchQuery, {
        title: 'Pull request instructions',
        description: 'Optional instructions appended only to pull-request detail prompts.',
        keywords: ['prompt', 'instructions', 'pull request', 'pr', 'description', 'template']
      }))
  ) {
    sections.push(
      <SearchableSetting
        key="pull-request-instructions"
        title="Pull request instructions"
        description="Optional instructions appended only to pull-request detail prompts."
        keywords={['prompt', 'instructions', 'pull request', 'pr', 'description', 'template']}
        forceVisible={isPullRequestInstructionsDirty}
        className="space-y-2 px-1 py-2"
      >
        <div className="space-y-0.5">
          <Label htmlFor="source-control-ai-pr-instructions">Pull request instructions</Label>
          <p className="text-xs text-muted-foreground">
            Appended only when generating pull request titles, descriptions, draft state, and base
            suggestions. These instructions never affect commit messages.
          </p>
        </div>
        <textarea
          id="source-control-ai-pr-instructions"
          rows={4}
          value={pullRequestInstructionsDraft}
          onChange={(e) => setPullRequestInstructionsDraft(e.target.value)}
          placeholder="Summarize user-visible changes first, then list reviewer notes and testing evidence."
          className="w-full resize-y rounded-md border border-border bg-background px-2 py-1.5 text-xs text-foreground outline-none placeholder:text-muted-foreground/70 focus-visible:ring-1 focus-visible:ring-ring"
        />
        <div className="flex items-center justify-between gap-3">
          <p className="text-[11px] text-muted-foreground">
            {isPullRequestInstructionsDirty ? 'Unsaved changes' : 'Saved'}
          </p>
          <div className="flex items-center gap-2">
            {isPullRequestInstructionsDirty ? (
              <Button
                type="button"
                variant="ghost"
                size="xs"
                onClick={() => onDiscardInstructions('pullRequest')}
                disabled={isSavingInstructions}
              >
                Discard
              </Button>
            ) : null}
            <Button
              type="button"
              variant="secondary"
              size="xs"
              onClick={() => void onSaveInstructions('pullRequest')}
              disabled={!isPullRequestInstructionsDirty || isSavingInstructions}
            >
              {isSavingInstructions ? 'Saving...' : 'Save'}
            </Button>
          </div>
        </div>
      </SearchableSetting>
    )
  }

  if (
    (config.enabled || isBranchNameInstructionsDirty) &&
    (isBranchNameInstructionsDirty ||
      matchesSettingsSearch(searchQuery, {
        title: 'Branch name instructions',
        description: 'Optional instructions appended only to auto branch-name prompts.',
        keywords: ['prompt', 'instructions', 'branch', 'branch name', 'rename', 'slug']
      }))
  ) {
    sections.push(
      <SearchableSetting
        key="branch-name-instructions"
        title="Branch name instructions"
        description="Optional instructions appended only to auto branch-name prompts."
        keywords={['prompt', 'instructions', 'branch', 'branch name', 'rename', 'slug']}
        forceVisible={isBranchNameInstructionsDirty}
        className="space-y-2 px-1 py-2"
      >
        <div className="space-y-0.5">
          <Label htmlFor="source-control-ai-branch-name-instructions">
            Branch name instructions
          </Label>
          <p className="text-xs text-muted-foreground">
            Appended only when Auto-Rename Branch From Work summarizes the first agent prompt.
            Output guardrails still force a short kebab-case branch leaf.
          </p>
        </div>
        <textarea
          id="source-control-ai-branch-name-instructions"
          rows={4}
          value={branchNameInstructionsDraft}
          onChange={(e) => setBranchNameInstructionsDraft(e.target.value)}
          placeholder="Prefer domain nouns from the task, avoid ticket IDs, and keep names reviewer-friendly."
          className="w-full resize-y rounded-md border border-border bg-background px-2 py-1.5 text-xs text-foreground outline-none placeholder:text-muted-foreground/70 focus-visible:ring-1 focus-visible:ring-ring"
        />
        <div className="flex items-center justify-between gap-3">
          <p className="text-[11px] text-muted-foreground">
            {isBranchNameInstructionsDirty ? 'Unsaved changes' : 'Saved'}
          </p>
          <div className="flex items-center gap-2">
            {isBranchNameInstructionsDirty ? (
              <Button
                type="button"
                variant="ghost"
                size="xs"
                onClick={() => onDiscardInstructions('branchName')}
                disabled={isSavingInstructions}
              >
                Discard
              </Button>
            ) : null}
            <Button
              type="button"
              variant="secondary"
              size="xs"
              onClick={() => void onSaveInstructions('branchName')}
              disabled={!isBranchNameInstructionsDirty || isSavingInstructions}
            >
              {isSavingInstructions ? 'Saving...' : 'Save'}
            </Button>
          </div>
        </div>
      </SearchableSetting>
    )
  }

  if (
    config.enabled &&
    matchesSettingsSearch(searchQuery, {
      title: 'PR creation defaults',
      description: 'Defaults used when the Create PR composer opens.',
      keywords: ['pull request', 'pr', 'draft', 'template', 'generate', 'open']
    })
  ) {
    const prDefaults = config.prCreationDefaults ?? {}
    const rows: {
      key: keyof NonNullable<SourceControlAiSettings['prCreationDefaults']>
      label: string
      description: string
    }[] = [
      {
        key: 'draft',
        label: 'Draft by default',
        description: 'Start new pull requests as drafts.'
      },
      {
        key: 'useTemplate',
        label: 'Use PR template when available',
        description: 'Prefer repository pull request templates when no description is set.'
      },
      {
        key: 'generateDetailsOnOpen',
        label: 'Generate details when opening Create PR',
        description: 'Run pull-request detail generation once when the composer opens.'
      },
      {
        key: 'openAfterCreate',
        label: 'Open PR after creation',
        description: 'Open the created hosted review in your browser after submit.'
      }
    ]
    sections.push(
      <SearchableSetting
        key="pr-creation-defaults"
        title="PR creation defaults"
        description="Defaults used when the Create PR composer opens."
        keywords={['pull request', 'pr', 'draft', 'template', 'generate', 'open']}
        className="space-y-3 px-1 py-2"
      >
        <div className="space-y-0.5">
          <Label>PR creation defaults</Label>
          <p className="text-xs text-muted-foreground">
            Provider-neutral defaults for the Create PR composer. Repo settings can override each
            field independently.
          </p>
        </div>
        <div className="space-y-2">
          {rows.map((row) => {
            const checked = prDefaults[row.key] === true
            return (
              <label
                key={row.key}
                className="flex items-start justify-between gap-4 rounded-md border border-border px-3 py-2"
              >
                <span className="space-y-0.5">
                  <span className="block text-xs font-medium text-foreground">{row.label}</span>
                  <span className="block text-[11px] text-muted-foreground">{row.description}</span>
                </span>
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={(event) => onPrDefaultChange(row.key, event.target.checked)}
                  className="mt-0.5 size-4 rounded border-border accent-primary"
                />
              </label>
            )
          })}
        </div>
      </SearchableSetting>
    )
  }

  if (sections.length === 0) {
    return <div className="space-y-4" />
  }
  // Why: this pane lives nested inside the Git section, so we draw an explicit
  // sub-heading + top border to keep its toggles visually distinct from the
  // Branch Prefix / Refresh Local Base Ref / Orca Attribution rows above.
  return (
    <div
      id="source-control-ai-settings"
      data-settings-section="source-control-ai-settings"
      className="space-y-4 border-t border-border/40 pt-4"
    >
      <div className="space-y-0.5">
        <h3 className="text-sm font-semibold">Source Control AI</h3>
        <p className="text-xs text-muted-foreground">
          Generate commit messages and pull request details using one background agent CLI.
        </p>
      </div>
      {sections}
    </div>
  )
}
