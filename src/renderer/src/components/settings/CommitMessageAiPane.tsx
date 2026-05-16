/* eslint-disable max-lines -- Why: each agent setting (toggle, agent dropdown,
   model dropdown, thinking effort dropdown, custom command, custom prompt) is
   a SearchableSetting block, and splitting the pane across files would scatter
   the ~6 conditional render branches without making any of them clearer. */
import { useEffect, useMemo, useRef, useState } from 'react'
import { RefreshCw, Terminal } from 'lucide-react'
import type { CommitMessageAiSettings, GlobalSettings, TuiAgent } from '../../../../shared/types'
import {
  CUSTOM_AGENT_ID,
  DEFAULT_COMMIT_MESSAGE_AGENT_ID,
  getCommitMessageAgentCapability,
  isCustomAgentId,
  listCommitMessageAgentCapabilities,
  type CommitMessageAgentChoice,
  type CommitMessageAgentCapability,
  type CommitMessageModelCapability
} from '../../../../shared/commit-message-agent-spec'
import { CUSTOM_PROMPT_PLACEHOLDER } from '../../../../shared/commit-message-prompt'
import {
  getCommitMessageModelDiscoveryHostKey,
  LOCAL_COMMIT_MESSAGE_HOST_KEY
} from '../../../../shared/commit-message-host-key'
import { AGENT_CATALOG, AgentIcon } from '@/lib/agent-catalog'
import { getConnectionId } from '@/lib/connection-context'
import { Label } from '../ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select'
import { useAppStore } from '../../store'
import { useActiveWorktree } from '../../store/selectors'
import { SearchableSetting } from './SearchableSetting'
import { matchesSettingsSearch } from './settings-search'

type CommitMessageAiPaneProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
}

const EMPTY_SETTINGS: CommitMessageAiSettings = {
  enabled: false,
  agentId: null,
  selectedModelByAgent: {},
  discoveredModelsByAgent: {},
  selectedThinkingByModel: {},
  customPrompt: '',
  customAgentCommand: ''
}

type ModelDiscoveryState = {
  status: 'idle' | 'loading' | 'ready' | 'error'
  hostKey: string
  models: CommitMessageModelCapability[]
  defaultModelId?: string
  error?: string
}

function readSettings(settings: GlobalSettings): CommitMessageAiSettings {
  return settings.commitMessageAi ?? EMPTY_SETTINGS
}

function agentLabel(agentId: TuiAgent, capability: CommitMessageAgentCapability): string {
  return AGENT_CATALOG.find((a) => a.id === agentId)?.label ?? capability.label
}

function readSelectedModelId(
  config: CommitMessageAiSettings,
  hostKey: string,
  agentId: TuiAgent
): string | undefined {
  return (
    config.selectedModelByAgentByHost?.[hostKey]?.[agentId] ??
    (hostKey === LOCAL_COMMIT_MESSAGE_HOST_KEY ? config.selectedModelByAgent[agentId] : undefined)
  )
}

function resolveSelectedModel(
  config: CommitMessageAiSettings,
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
  config: CommitMessageAiSettings,
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
  config: CommitMessageAiSettings,
  agentId: TuiAgent,
  models: CommitMessageModelCapability[],
  defaultModelId: string,
  hostKey = LOCAL_COMMIT_MESSAGE_HOST_KEY
): CommitMessageAiSettings {
  const hostSelectedModels = config.selectedModelByAgentByHost?.[hostKey] ?? {}
  const persisted = readSelectedModelId(config, hostKey, agentId)
  const nextModelId = models.some((model) => model.id === persisted) ? persisted : defaultModelId
  const nextHostSelectedModels =
    nextModelId && nextModelId !== persisted
      ? {
          ...hostSelectedModels,
          [agentId]: nextModelId
        }
      : hostSelectedModels
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
            nextModelId && nextModelId !== persisted
              ? {
                  ...config.selectedModelByAgent,
                  [agentId]: nextModelId
                }
              : config.selectedModelByAgent
        }
      : {}),
    discoveredModelsByAgentByHost: {
      ...config.discoveredModelsByAgentByHost,
      [hostKey]: nextHostDiscoveredModels
    },
    selectedModelByAgentByHost: {
      ...config.selectedModelByAgentByHost,
      [hostKey]: nextHostSelectedModels
    }
  }
}

function selectModelForHost(
  config: CommitMessageAiSettings,
  hostKey: string,
  agentId: TuiAgent,
  modelId: string
): Pick<CommitMessageAiSettings, 'selectedModelByAgent' | 'selectedModelByAgentByHost'> {
  const hostSelectedModels = config.selectedModelByAgentByHost?.[hostKey] ?? {}
  return {
    selectedModelByAgent:
      hostKey === LOCAL_COMMIT_MESSAGE_HOST_KEY
        ? {
            ...config.selectedModelByAgent,
            [agentId]: modelId
          }
        : config.selectedModelByAgent,
    selectedModelByAgentByHost: {
      ...config.selectedModelByAgentByHost,
      [hostKey]: {
        ...hostSelectedModels,
        [agentId]: modelId
      }
    }
  }
}

export function CommitMessageAiPane({
  settings,
  updateSettings
}: CommitMessageAiPaneProps): React.JSX.Element {
  const searchQuery = useAppStore((s) => s.settingsSearchQuery)
  const activeWorktree = useActiveWorktree()
  const activeConnectionId = getConnectionId(activeWorktree?.id ?? null)
  const discoveryHostKey = getCommitMessageModelDiscoveryHostKey(activeConnectionId)
  const config = readSettings(settings)
  const latestConfigRef = useRef(config)
  latestConfigRef.current = config
  const [modelDiscoveryByAgent, setModelDiscoveryByAgent] = useState<
    Partial<Record<TuiAgent, ModelDiscoveryState>>
  >({})

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
  const activeAgentId: CommitMessageAgentChoice = config.agentId ?? DEFAULT_COMMIT_MESSAGE_AGENT_ID
  const isCustom = isCustomAgentId(activeAgentId)
  const activeCapability = isCustom
    ? undefined
    : (agentCapabilities.find((capability) => capability.id === activeAgentId) ??
      getCommitMessageAgentCapability(activeAgentId))
  const activeModel = activeCapability
    ? resolveSelectedModel(config, activeCapability, discoveryHostKey)
    : null
  const activeThinking = activeModel ? resolveSelectedThinking(config, activeModel) : undefined
  const rawActiveDiscovery = !isCustom ? modelDiscoveryByAgent[activeAgentId] : undefined
  const activeDiscovery =
    rawActiveDiscovery?.hostKey === discoveryHostKey ? rawActiveDiscovery : undefined

  const writeConfig = (patch: Partial<CommitMessageAiSettings>): void => {
    updateSettings({ commitMessageAi: { ...config, ...patch } })
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
      const result = await window.api.git.discoverCommitMessageModels({
        agentId,
        ...(activeWorktree?.path ? { worktreePath: activeWorktree.path } : {}),
        ...(activeConnectionId ? { connectionId: activeConnectionId } : {})
      })
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
      const latestConfig = latestConfigRef.current
      updateSettings({
        commitMessageAi: mergeDiscoveredModelsIntoCommitMessageConfig(
          latestConfig,
          agentId,
          result.models,
          result.defaultModelId,
          discoveryHostKey
        )
      })
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
    // agent / model / thinking choices from provider capabilities so the
    // Generate button works immediately without forcing them to pick first.
    // If the user previously persisted 'custom', we keep that and let them
    // re-edit the command — no implicit reset to a preset.
    const seedAgentId: TuiAgent | 'custom' = config.agentId ?? DEFAULT_COMMIT_MESSAGE_AGENT_ID
    const seedCapability = isCustomAgentId(seedAgentId)
      ? undefined
      : getCommitMessageAgentCapability(seedAgentId)
    const seedModel = seedCapability
      ? resolveSelectedModel(config, seedCapability, discoveryHostKey)
      : null
    const seedThinking = seedModel ? resolveSelectedThinking(config, seedModel) : undefined

    const selectedModelPatch = seedCapability
      ? selectModelForHost(
          config,
          discoveryHostKey,
          seedCapability.id,
          readSelectedModelId(config, discoveryHostKey, seedCapability.id) ??
            seedCapability.defaultModelId
        )
      : {
          selectedModelByAgent: config.selectedModelByAgent,
          selectedModelByAgentByHost: config.selectedModelByAgentByHost
        }
    const nextSelectedThinkingByModel = { ...config.selectedThinkingByModel }
    if (seedModel && seedThinking && !nextSelectedThinkingByModel[seedModel.id]) {
      nextSelectedThinkingByModel[seedModel.id] = seedThinking
    }
    writeConfig({
      enabled: true,
      agentId: seedAgentId,
      ...selectedModelPatch,
      selectedThinkingByModel: nextSelectedThinkingByModel
    })
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
    const selectedModelPatch = selectModelForHost(
      config,
      discoveryHostKey,
      capability.id,
      readSelectedModelId(config, discoveryHostKey, capability.id) ?? capability.defaultModelId
    )
    const newModel = resolveSelectedModel(
      { ...config, ...selectedModelPatch, agentId: capability.id },
      capability,
      discoveryHostKey
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
      ...selectedModelPatch,
      selectedThinkingByModel: nextSelectedThinkingByModel
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
    const selectedModelPatch = selectModelForHost(
      config,
      discoveryHostKey,
      activeCapability.id,
      model.id
    )
    const nextSelectedThinkingByModel = { ...config.selectedThinkingByModel }
    if (
      model.thinkingLevels &&
      model.defaultThinkingLevel &&
      !nextSelectedThinkingByModel[model.id]
    ) {
      nextSelectedThinkingByModel[model.id] = model.defaultThinkingLevel
    }
    writeConfig({
      ...selectedModelPatch,
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

  const onCustomPromptChange = (value: string): void => {
    writeConfig({ customPrompt: value })
  }

  const sections: React.ReactNode[] = []

  if (
    matchesSettingsSearch(searchQuery, {
      title: 'Enable AI commit messages',
      description: 'Adds a Generate button to the Source Control panel.',
      keywords: ['ai', 'commit', 'message', 'generate', 'agent', 'enabled']
    })
  ) {
    sections.push(
      <SearchableSetting
        key="enabled"
        title="Enable AI commit messages"
        description="Adds a Generate button to the Source Control panel."
        keywords={['ai', 'commit', 'message', 'generate', 'agent', 'enabled']}
        className="flex items-center justify-between gap-4 px-1 py-2"
      >
        <div className="space-y-0.5">
          <Label>Enable AI commit messages</Label>
          <p className="text-xs text-muted-foreground">
            Adds a Generate button to the Source Control panel that drafts a commit message from
            your staged changes. Runs the agent CLI locally (or on the SSH host when working
            remotely) and waits for the response.
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
      description: 'Which agent to invoke when generating a commit message.',
      keywords: ['agent', 'claude', 'codex', 'opencode', 'gemini', 'cursor']
    })
  ) {
    sections.push(
      <SearchableSetting
        key="agent"
        title="Agent"
        description="Which agent to invoke when generating a commit message."
        keywords={['agent', 'claude', 'codex', 'opencode', 'gemini', 'cursor']}
        className="flex items-center justify-between gap-4 px-1 py-2"
      >
        <div className="space-y-0.5">
          <Label>Agent</Label>
          <p className="text-xs text-muted-foreground">
            Which agent drafts your commit messages. Orca invokes its CLI in the background, so the
            agent must be installed on the machine that hosts the worktree - your computer for local
            worktrees, or the SSH host for remote ones.
          </p>
        </div>
        <Select value={activeAgentId} onValueChange={onAgentChange}>
          <SelectTrigger size="sm" className="h-8 text-xs w-[220px]">
            <SelectValue />
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
            <SelectItem value={CUSTOM_AGENT_ID} className="cursor-pointer">
              <span className="flex items-center gap-2">
                <Terminal className="size-3.5" />
                <span>Custom</span>
              </span>
            </SelectItem>
          </SelectContent>
        </Select>
      </SearchableSetting>
    )
  }

  if (
    config.enabled &&
    isCustom &&
    matchesSettingsSearch(searchQuery, {
      title: 'Custom command',
      description: 'Command line Orca runs to generate the commit message.',
      keywords: ['custom', 'command', 'cli', 'binary', 'prompt', 'placeholder']
    })
  ) {
    sections.push(
      <SearchableSetting
        key="custom-command"
        title="Custom command"
        description="Command line Orca runs to generate the commit message."
        keywords={['custom', 'command', 'cli', 'binary', 'prompt', 'placeholder']}
        className="space-y-2 px-1 py-2"
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
      title: 'Model',
      description: 'Which model the selected agent uses to generate the message.',
      keywords: ['model', 'haiku', 'sonnet', 'opus', 'gpt']
    })
  ) {
    sections.push(
      <SearchableSetting
        key="model"
        title="Model"
        description="Which model the selected agent uses to generate the message."
        keywords={['model', 'haiku', 'sonnet', 'opus', 'gpt']}
        className="flex items-center justify-between gap-4 px-1 py-2"
      >
        <div className="space-y-0.5">
          <Label>Model</Label>
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
            <SelectTrigger size="sm" className="h-8 text-xs w-[240px]">
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
        className="flex items-center justify-between gap-4 px-1 py-2"
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
    matchesSettingsSearch(searchQuery, {
      title: 'Custom prompt',
      description:
        'Optional instructions appended to the base prompt (e.g. Conventional Commits style).',
      keywords: ['prompt', 'conventional commits', 'gitmoji', 'style']
    })
  ) {
    sections.push(
      <SearchableSetting
        key="custom-prompt"
        title="Custom prompt"
        description="Optional instructions appended to the base prompt (e.g. Conventional Commits style)."
        keywords={['prompt', 'conventional commits', 'gitmoji', 'style']}
        className="space-y-2 px-1 py-2"
      >
        <div className="space-y-0.5">
          <Label htmlFor="commit-message-ai-custom-prompt">Custom prompt</Label>
          <p className="text-xs text-muted-foreground">
            Appended verbatim to the base prompt. Use it to enforce Conventional Commits, gitmoji,
            ticket prefixes, or any other style your team prefers.
          </p>
        </div>
        <textarea
          id="commit-message-ai-custom-prompt"
          rows={4}
          value={config.customPrompt}
          onChange={(e) => onCustomPromptChange(e.target.value)}
          placeholder="Use Conventional Commits format (feat:, fix:, ...). Reference the ticket key when present."
          className="w-full resize-y rounded-md border border-border bg-background px-2 py-1.5 text-xs text-foreground outline-none placeholder:text-muted-foreground/70 focus-visible:ring-1 focus-visible:ring-ring"
        />
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
    <div className="space-y-4 border-t border-border/40 pt-4">
      <div className="space-y-0.5">
        <h3 className="text-sm font-semibold">AI Commit Messages</h3>
        <p className="text-xs text-muted-foreground">
          Generate commit messages from staged changes using a local agent CLI.
        </p>
      </div>
      {sections}
    </div>
  )
}
