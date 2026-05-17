/* eslint-disable max-lines -- Why: each agent setting (toggle, agent dropdown,
   model dropdown, thinking effort dropdown, custom command, custom prompt) is
   a SearchableSetting block, and splitting the pane across files would scatter
   the ~6 conditional render branches without making any of them clearer. */
import { useEffect, useMemo, useRef, useState } from 'react'
import { Terminal } from 'lucide-react'
import type { CommitMessageAiSettings, GlobalSettings, TuiAgent } from '../../../../shared/types'
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
import { AGENT_CATALOG, AgentIcon } from '@/lib/agent-catalog'
import { Button } from '../ui/button'
import { Label } from '../ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select'
import { useAppStore } from '../../store'
import { SearchableSetting } from './SearchableSetting'
import { matchesSettingsSearch } from './settings-search'

type CommitMessageAiPaneProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void | Promise<void>
  onCustomPromptDirtyChange?: (dirty: boolean) => void
  customPromptDiscardSignal?: number
}

const EMPTY_SETTINGS: CommitMessageAiSettings = {
  enabled: false,
  agentId: null,
  selectedModelByAgent: {},
  selectedThinkingByModel: {},
  customPrompt: '',
  customAgentCommand: ''
}

const UNCONFIGURED_AGENT_SELECT_VALUE = ''

function readSettings(settings: GlobalSettings): CommitMessageAiSettings {
  return settings.commitMessageAi ?? EMPTY_SETTINGS
}

function agentLabel(agentId: TuiAgent, capability: CommitMessageAgentCapability): string {
  return AGENT_CATALOG.find((a) => a.id === agentId)?.label ?? capability.label
}

function resolveSelectedModel(
  config: CommitMessageAiSettings,
  capability: CommitMessageAgentCapability
): CommitMessageModelCapability {
  const persisted = config.selectedModelByAgent[capability.id]
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

export function CommitMessageAiPane({
  settings,
  updateSettings,
  onCustomPromptDirtyChange,
  customPromptDiscardSignal
}: CommitMessageAiPaneProps): React.JSX.Element {
  const searchQuery = useAppStore((s) => s.settingsSearchQuery)
  const config = readSettings(settings)
  const persistedCustomPrompt = config.customPrompt
  const [customPromptDraft, setCustomPromptDraft] = useState(persistedCustomPrompt)
  const [isSavingCustomPrompt, setIsSavingCustomPrompt] = useState(false)
  const persistedCustomPromptRef = useRef(persistedCustomPrompt)
  const isCustomPromptDirty = customPromptDraft !== persistedCustomPrompt

  useEffect(() => {
    persistedCustomPromptRef.current = persistedCustomPrompt
  }, [persistedCustomPrompt])

  useEffect(() => {
    if (!isCustomPromptDirty) {
      setCustomPromptDraft(persistedCustomPrompt)
    }
  }, [isCustomPromptDirty, persistedCustomPrompt])

  useEffect(() => {
    setCustomPromptDraft(persistedCustomPromptRef.current)
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

  const agentCapabilities = useMemo(listCommitMessageAgentCapabilities, [])
  const resolvedAgentId = resolveCommitMessageAgentChoice(config.agentId, settings.defaultTuiAgent)
  const activeAgentSelectValue = resolvedAgentId ?? UNCONFIGURED_AGENT_SELECT_VALUE
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
  const isCustom = isCustomAgentId(resolvedAgentId)
  const activeCapability =
    resolvedAgentId && !isCustomAgentId(resolvedAgentId)
      ? getCommitMessageAgentCapability(resolvedAgentId)
      : undefined
  const activeModel = activeCapability ? resolveSelectedModel(config, activeCapability) : null
  const activeThinking = activeModel ? resolveSelectedThinking(config, activeModel) : undefined

  const writeConfig = (patch: Partial<CommitMessageAiSettings>): void => {
    updateSettings({ commitMessageAi: { ...config, ...patch } })
  }

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
    const seedAgentId = resolveCommitMessageAgentChoice(config.agentId, settings.defaultTuiAgent)
    if (!seedAgentId) {
      writeConfig({ enabled: true, agentId: null })
      return
    }
    const seedCapability = isCustomAgentId(seedAgentId)
      ? undefined
      : getCommitMessageAgentCapability(seedAgentId)
    const seedModel = seedCapability ? resolveSelectedModel(config, seedCapability) : null
    const seedThinking = seedModel ? resolveSelectedThinking(config, seedModel) : undefined

    const nextSelectedModelByAgent = { ...config.selectedModelByAgent }
    if (seedCapability && !nextSelectedModelByAgent[seedCapability.id]) {
      nextSelectedModelByAgent[seedCapability.id] = seedCapability.defaultModelId
    }
    const nextSelectedThinkingByModel = { ...config.selectedThinkingByModel }
    if (seedModel && seedThinking && !nextSelectedThinkingByModel[seedModel.id]) {
      nextSelectedThinkingByModel[seedModel.id] = seedThinking
    }
    writeConfig({
      enabled: true,
      agentId: seedAgentId,
      selectedModelByAgent: nextSelectedModelByAgent,
      selectedThinkingByModel: nextSelectedThinkingByModel
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
    const nextSelectedModelByAgent = { ...config.selectedModelByAgent }
    if (!nextSelectedModelByAgent[capability.id]) {
      nextSelectedModelByAgent[capability.id] = capability.defaultModelId
    }
    const newModel = resolveSelectedModel({ ...config, agentId: capability.id }, capability)
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

  const onSaveCustomPrompt = async (): Promise<void> => {
    if (!isCustomPromptDirty || isSavingCustomPrompt) {
      return
    }
    setIsSavingCustomPrompt(true)
    try {
      await updateSettings({ commitMessageAi: { ...config, customPrompt: customPromptDraft } })
    } finally {
      setIsSavingCustomPrompt(false)
    }
  }

  const onDiscardCustomPrompt = (): void => {
    setCustomPromptDraft(persistedCustomPrompt)
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
      keywords: ['agent', 'claude', 'codex']
    })
  ) {
    sections.push(
      <SearchableSetting
        key="agent"
        title="Agent"
        description="Which agent to invoke when generating a commit message."
        keywords={['agent', 'claude', 'codex']}
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
        <div className="flex flex-col items-end gap-1">
          <Select value={activeAgentSelectValue} onValueChange={onAgentChange}>
            <SelectTrigger size="sm" className="h-8 text-xs w-[180px]">
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
              Your default agent is {unsupportedDefaultAgentLabel}, which does not support commit
              message generation yet. Choose Claude, Codex, or Custom.
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
            Defaults to the strongest available model for the selected agent. Pick a smaller one if
            you prefer lower latency or cost.
          </p>
        </div>
        <Select value={activeModel.id} onValueChange={onModelChange}>
          <SelectTrigger size="sm" className="h-8 text-xs w-[200px]">
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
    (config.enabled || isCustomPromptDirty) &&
    (isCustomPromptDirty ||
      matchesSettingsSearch(searchQuery, {
        title: 'Custom prompt',
        description:
          'Optional instructions appended to the base prompt (e.g. Conventional Commits style).',
        keywords: ['prompt', 'conventional commits', 'gitmoji', 'style']
      }))
  ) {
    sections.push(
      <SearchableSetting
        key="custom-prompt"
        title="Custom prompt"
        description="Optional instructions appended to the base prompt (e.g. Conventional Commits style)."
        keywords={['prompt', 'conventional commits', 'gitmoji', 'style']}
        forceVisible={isCustomPromptDirty}
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
          value={customPromptDraft}
          onChange={(e) => setCustomPromptDraft(e.target.value)}
          placeholder="Use Conventional Commits format (feat:, fix:, ...). Reference the ticket key when present."
          className="w-full resize-y rounded-md border border-border bg-background px-2 py-1.5 text-xs text-foreground outline-none placeholder:text-muted-foreground/70 focus-visible:ring-1 focus-visible:ring-ring"
        />
        <div className="flex items-center justify-between gap-3">
          <p className="text-[11px] text-muted-foreground">
            {isCustomPromptDirty ? 'Unsaved changes' : 'Saved'}
          </p>
          <div className="flex items-center gap-2">
            {isCustomPromptDirty ? (
              <Button
                type="button"
                variant="ghost"
                size="xs"
                onClick={onDiscardCustomPrompt}
                disabled={isSavingCustomPrompt}
              >
                Discard
              </Button>
            ) : null}
            <Button
              type="button"
              variant="secondary"
              size="xs"
              onClick={() => void onSaveCustomPrompt()}
              disabled={!isCustomPromptDirty || isSavingCustomPrompt}
            >
              {isSavingCustomPrompt ? 'Saving...' : 'Save'}
            </Button>
          </div>
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
