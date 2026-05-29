import { useEffect, useState, type JSX } from 'react'
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
import { AgentIcon, AGENT_CATALOG } from '@/lib/agent-catalog'
import { cn } from '@/lib/utils'
import { useAppStore } from '@/store'
import { Input } from '../ui/input'
import { Label } from '../ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select'

const EMPTY_SETTINGS: CommitMessageAiSettings = {
  enabled: false,
  agentId: null,
  selectedModelByAgent: {},
  selectedThinkingByModel: {},
  customPrompt: '',
  customAgentCommand: ''
}

function readCommitMessageAiSettings(settings: GlobalSettings): CommitMessageAiSettings {
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

function SettingsSwitch(props: {
  checked: boolean
  label: string
  onToggle: () => void
}): JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      aria-label={props.label}
      aria-checked={props.checked}
      onClick={props.onToggle}
      className={cn(
        'relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border border-transparent transition-colors',
        props.checked ? 'bg-foreground' : 'bg-muted-foreground/30'
      )}
    >
      <span
        className={cn(
          'pointer-events-none block size-3.5 rounded-full bg-background shadow-sm transition-transform',
          props.checked ? 'translate-x-4' : 'translate-x-0.5'
        )}
      />
    </button>
  )
}

export function AiCommitPrSettingsCard(): JSX.Element | null {
  const settings = useAppStore((s) => s.settings)
  const updateSettings = useAppStore((s) => s.updateSettings)
  // Why: Radix Select's Portal renders to document.body by default. In
  // onboarding that puts menus behind the z-[100] fullscreen tour layer, so
  // portal into the active tour/dialog surface instead.
  const [selectPortalRoot, setSelectPortalRoot] = useState<HTMLElement | null>(null)
  useEffect(() => {
    const el = document.querySelector<HTMLElement>(
      '[data-onboarding-overlay], [data-slot="dialog-content"]'
    )
    setSelectPortalRoot(el)
  }, [])
  if (!settings) {
    return null
  }

  const config = readCommitMessageAiSettings(settings)
  const resolvedAgentId = resolveCommitMessageAgentChoice(
    config.agentId,
    settings.defaultTuiAgent,
    settings.disabledTuiAgents
  )
  const isCustom = isCustomAgentId(resolvedAgentId)
  const activeCapability =
    resolvedAgentId && !isCustomAgentId(resolvedAgentId)
      ? getCommitMessageAgentCapability(resolvedAgentId)
      : undefined
  const unsupportedConfiguredAgent =
    resolvedAgentId && !isCustom && !activeCapability ? resolvedAgentId : null
  const unsupportedConfiguredAgentLabel = unsupportedConfiguredAgent
    ? (AGENT_CATALOG.find((a) => a.id === unsupportedConfiguredAgent)?.label ??
      unsupportedConfiguredAgent)
    : null
  const agentSelectValue = activeCapability
    ? activeCapability.id
    : isCustom
      ? CUSTOM_AGENT_ID
      : undefined
  const activeModel = activeCapability ? resolveSelectedModel(config, activeCapability) : null
  const activeThinking = activeModel ? resolveSelectedThinking(config, activeModel) : undefined
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
  const unsupportedAgentLabel = unsupportedConfiguredAgentLabel ?? unsupportedDefaultAgentLabel

  const writeConfig = (patch: Partial<CommitMessageAiSettings>): void => {
    updateSettings({ commitMessageAi: { ...config, ...patch } })
  }

  const toggleAi = (): void => {
    const nextEnabled = !config.enabled
    if (!nextEnabled) {
      writeConfig({ enabled: false })
      return
    }
    // Why: this compact tour card must behave like Settings > Git: first
    // enable seeds the agent/model from the default agent when possible.
    const seedAgentId = resolveCommitMessageAgentChoice(
      config.agentId,
      settings.defaultTuiAgent,
      settings.disabledTuiAgents
    )
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

  return (
    <div className="rounded-xl border border-border bg-muted/20 p-3.5">
      <div className="space-y-2.5">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="text-[15px] font-semibold leading-tight text-foreground">AI author</div>
          </div>
          <SettingsSwitch checked={config.enabled} label="Enable AI author" onToggle={toggleAi} />
        </div>

        {config.enabled ? (
          <div className="flex flex-col gap-2.5">
            <div className="grid grid-cols-[92px_minmax(0,1fr)] items-center gap-3">
              <Label className="text-xs">Agent</Label>
              <Select value={agentSelectValue} onValueChange={onAgentChange}>
                <SelectTrigger size="sm" className="h-8 w-full text-xs">
                  <span
                    className={cn(
                      'flex min-w-0 items-center gap-2',
                      !activeCapability && !isCustom ? 'text-muted-foreground' : null
                    )}
                  >
                    {activeCapability ? (
                      <>
                        <AgentIcon agent={activeCapability.id} size={14} />
                        <span className="truncate">
                          {agentLabel(activeCapability.id, activeCapability)}
                        </span>
                      </>
                    ) : isCustom ? (
                      <>
                        <Terminal className="size-3.5" />
                        <span>Custom</span>
                      </>
                    ) : (
                      <span className="truncate">
                        {unsupportedAgentLabel
                          ? `${unsupportedAgentLabel} unsupported`
                          : 'Not configured'}
                      </span>
                    )}
                  </span>
                </SelectTrigger>
                <SelectContent portalContainer={selectPortalRoot} position="popper" align="start">
                  {listCommitMessageAgentCapabilities().map((capability) => (
                    <SelectItem
                      key={capability.id}
                      value={capability.id}
                      className="cursor-pointer"
                    >
                      <span className="flex items-center gap-2">
                        <AgentIcon agent={capability.id} size={14} />
                        <span>{agentLabel(capability.id, capability)}</span>
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
              {unsupportedAgentLabel ? (
                <p className="col-start-2 text-[11px] leading-snug text-muted-foreground">
                  {unsupportedAgentLabel} unsupported. Choose Claude, Codex, or Custom.
                </p>
              ) : null}
            </div>

            {activeCapability && activeModel ? (
              <div className="grid grid-cols-[92px_minmax(0,1fr)] items-center gap-3">
                <Label className="text-xs">Model</Label>
                <Select value={activeModel.id} onValueChange={onModelChange}>
                  <SelectTrigger size="sm" className="h-8 w-full text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent portalContainer={selectPortalRoot} position="popper" align="start">
                    {activeCapability.models.map((model) => (
                      <SelectItem key={model.id} value={model.id} className="cursor-pointer">
                        {model.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            ) : null}

            {activeModel?.thinkingLevels && activeThinking ? (
              <div className="grid grid-cols-[92px_minmax(0,1fr)] items-center gap-3">
                <Label className="text-xs">Thinking effort</Label>
                <Select value={activeThinking} onValueChange={onThinkingChange}>
                  <SelectTrigger size="sm" className="h-8 w-full text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent portalContainer={selectPortalRoot} position="popper" align="start">
                    {activeModel.thinkingLevels.map((level) => (
                      <SelectItem key={level.id} value={level.id} className="cursor-pointer">
                        {level.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            ) : null}

            {isCustom ? (
              <div className="space-y-1.5">
                <Label htmlFor="feature-wall-ai-commit-custom-command" className="text-xs">
                  Custom command
                </Label>
                <Input
                  id="feature-wall-ai-commit-custom-command"
                  value={config.customAgentCommand}
                  onChange={(event) => writeConfig({ customAgentCommand: event.target.value })}
                  placeholder={`e.g. ollama run llama3.1 ${CUSTOM_PROMPT_PLACEHOLDER}`}
                  spellCheck={false}
                  className="h-8 font-mono text-xs"
                />
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  )
}
