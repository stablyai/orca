/* eslint-disable max-lines -- Why: the Agents pane keeps catalog rows, default
   selection, and per-agent controls together so settings reconciliation stays
   visible in one file. */
import { useEffect, useId, useMemo, useRef, useState } from 'react'
import {
  Check,
  ChevronDown,
  ExternalLink,
  Pencil,
  Plus,
  RefreshCw,
  Save,
  Terminal,
  Trash2,
  X
} from 'lucide-react'
import type {
  CustomTuiAgent,
  CustomTuiAgentId,
  GlobalSettings,
  TuiAgent,
  TuiAgentId
} from '../../../../shared/types'
import {
  generateCustomTuiAgentId,
  isCustomTuiAgentId
} from '../../../../shared/effective-tui-agent'
import {
  AGENT_CATALOG,
  AgentIcon,
  buildAgentCatalog,
  resolveCustomAgentIconSource
} from '@/lib/agent-catalog'
import { useDetectedAgents } from '@/hooks/useDetectedAgents'
import { useAppStore } from '@/store'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { cn } from '@/lib/utils'
import { AgentAwakeSetting } from './AgentAwakeSetting'
import { AGENT_STATUS_HOOKS_DESCRIPTION, AGENT_STATUS_HOOKS_TITLE } from './agent-status-hooks-copy'
import {
  SettingsBadge,
  SettingsSegmentedControl,
  SettingsSubsectionHeader,
  SettingsSwitchRow
} from './SettingsFormControls'
import {
  isTuiAgentEnabled,
  normalizeDisabledTuiAgents
} from '../../../../shared/tui-agent-selection'

export { AGENTS_PANE_SEARCH_ENTRIES } from './agents-search'

type AgentsPaneProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
}

const EMPTY_CUSTOM_TUI_AGENTS: readonly CustomTuiAgent[] = []

type AgentRowProps = {
  agentId: TuiAgent
  label: string
  homepageUrl: string
  defaultCmd: string
  isDetected: boolean
  isEnabled: boolean
  isDefault: boolean
  cmdOverride: string | undefined
  onSetDefault: () => void
  onToggleEnabled: () => void
  onSaveOverride: (value: string) => void
}

type AgentCommandOverrideInputProps = {
  defaultCmd: string
  cmdOverride: string | undefined
  onSaveOverride: (value: string) => void
}

type AgentAvailability = 'enabled' | 'disabled'

type AgentAvailabilityControlProps = {
  label: string
  isEnabled: boolean
  onToggleEnabled: () => void
}

export function buildAgentEnabledSettingsUpdate(
  settings: Pick<GlobalSettings, 'defaultTuiAgent' | 'disabledTuiAgents'>,
  id: TuiAgent
): Pick<GlobalSettings, 'disabledTuiAgents'> & Partial<Pick<GlobalSettings, 'defaultTuiAgent'>> {
  const latestDisabled = normalizeDisabledTuiAgents(settings.disabledTuiAgents)
  const wasDisabled = latestDisabled.includes(id)
  const nextDisabled = wasDisabled
    ? latestDisabled.filter((agent) => agent !== id)
    : [...latestDisabled, id]

  return {
    disabledTuiAgents: nextDisabled,
    ...(settings.defaultTuiAgent === id && !wasDisabled ? { defaultTuiAgent: null } : {})
  }
}

export function AgentAvailabilityControl({
  label,
  isEnabled,
  onToggleEnabled
}: AgentAvailabilityControlProps): React.JSX.Element {
  const value: AgentAvailability = isEnabled ? 'enabled' : 'disabled'

  return (
    <SettingsSegmentedControl<AgentAvailability>
      value={value}
      onChange={(next) => {
        if (next !== value) {
          onToggleEnabled()
        }
      }}
      ariaLabel={`${label} availability`}
      size="sm"
      options={[
        { value: 'enabled', label: 'Enabled' },
        { value: 'disabled', label: 'Disabled' }
      ]}
    />
  )
}

type CustomAgentDraft = {
  label: string
  command: string
  detectCmd: string
}

type CustomAgentDraftState =
  | ({ mode: 'new' } & CustomAgentDraft)
  | ({ mode: 'edit'; id: CustomTuiAgentId } & CustomAgentDraft)

const EMPTY_CUSTOM_AGENT_DRAFT: CustomAgentDraft = {
  label: '',
  command: '',
  detectCmd: ''
}

function trimCustomAgentDraft(draft: CustomAgentDraft): CustomAgentDraft {
  return {
    label: draft.label.trim(),
    command: draft.command.trim(),
    detectCmd: draft.detectCmd.trim()
  }
}

function buildCustomAgentFromDraft(draft: CustomAgentDraft): CustomTuiAgent {
  const trimmed = trimCustomAgentDraft(draft)
  const label = trimmed.label || 'Custom agent'
  return {
    id: generateCustomTuiAgentId(label),
    label,
    command: trimmed.command,
    detectCmd: trimmed.detectCmd || undefined,
    promptInjectionMode: 'stdin-after-start'
  }
}

function customAgentDraftFromAgent(agent: CustomTuiAgent): CustomAgentDraft {
  return {
    label: agent.label,
    command: agent.command,
    detectCmd: agent.detectCmd ?? ''
  }
}

export function buildDeleteCustomAgentSettings(
  settings: GlobalSettings,
  id: CustomTuiAgentId
): Pick<GlobalSettings, 'agentCmdOverrides' | 'customTuiAgents' | 'defaultTuiAgent'> {
  const { [id]: _removed, ...nextOverrides } = settings.agentCmdOverrides ?? {}
  return {
    customTuiAgents: (settings.customTuiAgents ?? []).filter((agent) => agent.id !== id),
    defaultTuiAgent: settings.defaultTuiAgent === id ? null : settings.defaultTuiAgent,
    agentCmdOverrides: nextOverrides
  }
}

export function buildCreateCustomAgentSettings(
  settings: GlobalSettings,
  draft: CustomAgentDraft
): Pick<GlobalSettings, 'customTuiAgents'> {
  return {
    customTuiAgents: [...(settings.customTuiAgents ?? []), buildCustomAgentFromDraft(draft)]
  }
}

export function buildUpdateCustomAgentSettings(
  settings: GlobalSettings,
  id: CustomTuiAgentId,
  draft: CustomAgentDraft
): Pick<GlobalSettings, 'customTuiAgents'> {
  const trimmed = trimCustomAgentDraft(draft)
  return {
    customTuiAgents: (settings.customTuiAgents ?? []).map((agent) =>
      agent.id === id
        ? {
            ...agent,
            label: trimmed.label || agent.label,
            command: trimmed.command,
            detectCmd: trimmed.detectCmd || undefined,
            promptInjectionMode: 'stdin-after-start'
          }
        : agent
    )
  }
}

function AgentCommandOverrideInput({
  defaultCmd,
  cmdOverride,
  onSaveOverride
}: AgentCommandOverrideInputProps): React.JSX.Element {
  const draftSeed = cmdOverride ?? defaultCmd
  const [cmdDraft, setCmdDraft] = useState(draftSeed)

  const commitCmd = (): void => {
    const trimmed = cmdDraft.trim()
    if (!trimmed || trimmed === defaultCmd) {
      onSaveOverride('')
      setCmdDraft(defaultCmd)
    } else {
      onSaveOverride(trimmed)
    }
  }

  return (
    <div className="flex items-center gap-2">
      <span className="shrink-0 text-xs text-muted-foreground">Command</span>
      <Input
        value={cmdDraft}
        onChange={(e) => setCmdDraft(e.target.value)}
        onBlur={commitCmd}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            commitCmd()
            e.currentTarget.blur()
          }
          if (e.key === 'Escape') {
            setCmdDraft(draftSeed)
            e.currentTarget.blur()
          }
        }}
        placeholder={defaultCmd}
        spellCheck={false}
        className="h-7 flex-1 font-mono text-xs"
      />
      {cmdOverride && (
        <Button
          type="button"
          variant="ghost"
          size="xs"
          onClick={() => {
            onSaveOverride('')
            setCmdDraft(defaultCmd)
          }}
          className="h-7 shrink-0 text-xs text-muted-foreground hover:text-foreground"
        >
          Reset
        </Button>
      )}
    </div>
  )
}

type CustomAgentEditorProps = {
  draft: CustomAgentDraftState
  onDraftChange: (patch: Partial<CustomAgentDraft>) => void
  onSave: () => void
  onCancel: () => void
  inline?: boolean
}

function CustomAgentEditor({
  draft,
  onDraftChange,
  onSave,
  onCancel,
  inline = false
}: CustomAgentEditorProps): React.JSX.Element {
  const nameInputRef = useRef<HTMLInputElement | null>(null)
  const nameInputId = useId()
  const commandInputId = useId()
  const detectInputId = useId()
  const isSaveEnabled = draft.label.trim().length > 0 && draft.command.trim().length > 0

  useEffect(() => {
    nameInputRef.current?.focus()
    if (draft.mode === 'new') {
      nameInputRef.current?.select()
    }
  }, [draft.mode])

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault()
        if (isSaveEnabled) {
          onSave()
        }
      }}
      className={cn(
        'space-y-3',
        inline
          ? 'border-t border-border/40 pt-3'
          : 'rounded-md border border-border/60 bg-card/60 p-3'
      )}
    >
      <div className="space-y-1.5">
        <label htmlFor={nameInputId} className="text-xs font-medium text-muted-foreground">
          Name
        </label>
        <Input
          id={nameInputId}
          ref={nameInputRef}
          value={draft.label}
          onChange={(event) => onDraftChange({ label: event.target.value })}
          placeholder="Your agent"
          spellCheck={false}
          className="h-8 text-xs"
        />
      </div>

      <div className="space-y-1.5">
        <label htmlFor={commandInputId} className="text-xs font-medium text-muted-foreground">
          Launch command
        </label>
        <Input
          id={commandInputId}
          value={draft.command}
          onChange={(event) => onDraftChange({ command: event.target.value })}
          placeholder="agent --profile work"
          spellCheck={false}
          className="h-8 font-mono text-xs"
        />
      </div>

      <div className="space-y-1.5">
        <label htmlFor={detectInputId} className="text-xs font-medium text-muted-foreground">
          Detect command <span className="font-normal text-muted-foreground/70">optional</span>
        </label>
        <Input
          id={detectInputId}
          value={draft.detectCmd}
          onChange={(event) => onDraftChange({ detectCmd: event.target.value })}
          placeholder="agent"
          spellCheck={false}
          className="h-8 font-mono text-xs"
        />
        <span className="block text-[11px] text-muted-foreground">
          Executable Orca looks for on PATH to mark this preset as installed, for example{' '}
          <span className="font-mono text-foreground/70">codex</span> or{' '}
          <span className="font-mono text-foreground/70">claude</span>. Launching always uses the
          launch command above. Leave blank to use the first token of the launch command.
        </span>
      </div>

      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" size="xs" onClick={onCancel}>
          <X className="size-3" />
          Cancel
        </Button>
        <Button type="submit" size="xs" disabled={!isSaveEnabled}>
          <Save className="size-3" />
          Save
        </Button>
      </div>
    </form>
  )
}

type CustomAgentRowProps = {
  agent: CustomTuiAgent
  isDefault: boolean
  isEditing: boolean
  editorDraft: CustomAgentDraftState | null
  onSetDefault: () => void
  onEdit: () => void
  onCancelEdit: () => void
  onDelete: () => void
  onDraftChange: (patch: Partial<CustomAgentDraft>) => void
  onSaveDraft: () => void
}

function CustomAgentRow({
  agent,
  isDefault,
  isEditing,
  editorDraft,
  onSetDefault,
  onEdit,
  onCancelEdit,
  onDelete,
  onDraftChange,
  onSaveDraft
}: CustomAgentRowProps): React.JSX.Element {
  const commandReady = agent.command.trim().length > 0
  const catalog = useMemo(() => {
    const iconSource = agent.faviconDomain ? undefined : resolveCustomAgentIconSource(agent)
    return [
      {
        id: agent.id,
        label: agent.label,
        cmd: agent.command,
        faviconDomain: agent.faviconDomain ?? iconSource?.faviconDomain,
        iconSourceId: iconSource?.id,
        homepageUrl: agent.homepageUrl,
        isCustom: true
      }
    ]
  }, [agent])

  return (
    <div className="py-3">
      <div className="flex flex-wrap items-start gap-3">
        <div className="flex size-7 shrink-0 items-center justify-center rounded-md border border-border/50 bg-background/50">
          <AgentIcon agent={agent.id} size={16} catalog={catalog} />
        </div>

        <div className="min-w-0 flex-1 sm:min-w-[12rem]">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-medium leading-none">{agent.label}</span>
            <SettingsBadge tone="accent">Custom</SettingsBadge>
            {!commandReady && <SettingsBadge tone="muted">Missing command</SettingsBadge>}
          </div>
          <div className="mt-1 truncate font-mono text-[11px] text-muted-foreground">
            {agent.command || 'No launch command'}
          </div>
          {agent.detectCmd ? (
            <div className="mt-1 truncate text-[11px] text-muted-foreground">
              Detect command:{' '}
              <span className="font-mono text-foreground/70">{agent.detectCmd}</span>
            </div>
          ) : null}
        </div>

        <div className="ml-auto flex shrink-0 flex-wrap items-center justify-end gap-1.5">
          {commandReady && (
            <Button
              type="button"
              variant={isDefault ? 'secondary' : 'ghost'}
              size="xs"
              onClick={onSetDefault}
              title={isDefault ? 'Default agent' : 'Set as default'}
              className="h-7 gap-1 text-xs"
            >
              {isDefault && <Check className="size-3" />}
              {isDefault ? 'Default' : 'Set default'}
            </Button>
          )}
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            onClick={isEditing ? onCancelEdit : onEdit}
            aria-label={isEditing ? `Close editor for ${agent.label}` : `Edit ${agent.label}`}
            title={isEditing ? 'Close editor' : `Edit ${agent.label}`}
            className={cn(
              'size-7 text-muted-foreground hover:text-foreground',
              isEditing && 'text-foreground'
            )}
          >
            <Pencil className="size-3.5" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            onClick={onDelete}
            aria-label={`Delete ${agent.label}`}
            title={`Delete ${agent.label}`}
            className="size-7 text-destructive hover:text-destructive"
          >
            <Trash2 className="size-3.5" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            onClick={isEditing ? onCancelEdit : onEdit}
            aria-label={isEditing ? 'Collapse custom agent editor' : 'Expand custom agent editor'}
            className="size-7 text-muted-foreground hover:text-foreground"
          >
            <ChevronDown
              className={cn('size-3.5 transition-transform', isEditing && 'rotate-180')}
            />
          </Button>
        </div>
      </div>

      {isEditing && editorDraft ? (
        <div className="mt-3 pl-10">
          <CustomAgentEditor
            inline
            draft={editorDraft}
            onDraftChange={onDraftChange}
            onSave={onSaveDraft}
            onCancel={onCancelEdit}
          />
        </div>
      ) : null}
    </div>
  )
}

function AgentRow({
  agentId,
  label,
  homepageUrl,
  defaultCmd,
  isDetected,
  isEnabled,
  isDefault,
  cmdOverride,
  onSetDefault,
  onToggleEnabled,
  onSaveOverride
}: AgentRowProps): React.JSX.Element {
  const [cmdOpen, setCmdOpen] = useState(Boolean(cmdOverride))
  const availabilityDescription = isEnabled
    ? isDetected
      ? 'Shown in launch and default choices.'
      : 'Install to use in launch and default choices.'
    : isDetected
      ? 'Hidden from launch and default choices.'
      : 'Hidden from launch and default choices if installed.'

  return (
    <div className={cn('py-3', !isDetected && 'opacity-70')}>
      <div className="flex flex-wrap items-start gap-3">
        <div className="flex size-7 shrink-0 items-center justify-center rounded-md border border-border/50 bg-background/50">
          <AgentIcon agent={agentId} size={16} />
        </div>

        <div className="min-w-0 flex-1 sm:min-w-[12rem]">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium leading-none">{label}</span>
            {isDetected ? (
              <SettingsBadge tone="accent">Detected</SettingsBadge>
            ) : (
              <SettingsBadge tone="muted">Not installed</SettingsBadge>
            )}
            {!isEnabled && <SettingsBadge tone="muted">Disabled</SettingsBadge>}
          </div>
          <div className="mt-1 truncate font-mono text-[11px] text-muted-foreground">
            {cmdOverride ? (
              <span>
                <span className="text-muted-foreground/60 line-through">{defaultCmd}</span>
                <span className="ml-1.5 text-foreground/80">{cmdOverride}</span>
              </span>
            ) : (
              defaultCmd
            )}
          </div>
          <div className="mt-1 text-[11px] text-muted-foreground">{availabilityDescription}</div>
        </div>

        <div className="ml-auto flex shrink-0 flex-wrap items-center justify-end gap-1.5">
          <AgentAvailabilityControl
            label={label}
            isEnabled={isEnabled}
            onToggleEnabled={onToggleEnabled}
          />

          {isDetected && isEnabled && (
            <Button
              type="button"
              variant={isDefault ? 'secondary' : 'ghost'}
              size="xs"
              onClick={onSetDefault}
              title={isDefault ? 'Default agent' : 'Set as default'}
              className="h-7 gap-1 text-xs"
            >
              {isDefault && <Check className="size-3" />}
              {isDefault ? 'Default' : 'Set default'}
            </Button>
          )}

          {isDetected && (
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              onClick={() => setCmdOpen((prev) => !prev)}
              title="Customize command"
              aria-expanded={cmdOpen}
              className={cn(
                'size-7 text-muted-foreground hover:text-foreground',
                (cmdOpen || cmdOverride) && 'text-foreground'
              )}
            >
              <Terminal className="size-3.5" />
            </Button>
          )}

          <a
            href={homepageUrl}
            target="_blank"
            rel="noopener noreferrer"
            title={isDetected ? 'Docs' : 'Install'}
            className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
          >
            <ExternalLink className="size-3.5" />
          </a>

          {isDetected && (
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              onClick={() => setCmdOpen((prev) => !prev)}
              aria-label={cmdOpen ? 'Collapse command override' : 'Expand command override'}
              className="size-7 text-muted-foreground hover:text-foreground"
            >
              <ChevronDown
                className={cn('size-3.5 transition-transform', cmdOpen && 'rotate-180')}
              />
            </Button>
          )}
        </div>
      </div>

      {isDetected && cmdOpen && (
        <div className="mt-3 pl-10">
          {/* Why: key by the persisted seed so settings changes reset the draft during reconciliation, not in a follow-up effect commit. */}
          <AgentCommandOverrideInput
            key={cmdOverride ?? defaultCmd}
            defaultCmd={defaultCmd}
            cmdOverride={cmdOverride}
            onSaveOverride={onSaveOverride}
          />
          <p className="mt-1.5 text-[11px] text-muted-foreground">
            Override the binary path or name used to launch this agent.
          </p>
        </div>
      )}
    </div>
  )
}

type DefaultAgentPillProps = {
  active: boolean
  onClick: () => void
  children: React.ReactNode
}

function DefaultAgentPill({ active, onClick, children }: DefaultAgentPillProps): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        'inline-flex items-center gap-2 rounded-md border px-3 py-1.5 text-sm outline-none transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/50',
        active
          ? 'border-muted-foreground/40 bg-accent font-medium text-accent-foreground'
          : 'border-border bg-background/50 text-muted-foreground hover:border-muted-foreground/35 hover:text-foreground'
      )}
    >
      {children}
    </button>
  )
}

export function AgentsPane({ settings, updateSettings }: AgentsPaneProps): React.JSX.Element {
  const { detectedIds: detectedList, isRefreshing, refresh } = useDetectedAgents()
  // Why: refresh re-spawns the user's login shell to re-capture PATH
  // (preflight:refreshAgents on the main side). This handles the
  // "installed a new CLI, Orca doesn't see it yet" case without a restart.
  const handleRefresh = (): void => {
    void refresh()
  }
  const detectedIds = useMemo<Set<string> | null>(
    () => (detectedList ? new Set(detectedList) : null),
    [detectedList]
  )

  const defaultAgent = settings.defaultTuiAgent
  const cmdOverrides = settings.agentCmdOverrides ?? {}
  const customAgents = settings.customTuiAgents ?? EMPTY_CUSTOM_TUI_AGENTS
  const mergedCatalog = useMemo(() => buildAgentCatalog(customAgents), [customAgents])
  const customDefaultAgents = useMemo(
    () => mergedCatalog.filter((agent) => agent.isCustom),
    [mergedCatalog]
  )
  const validCustomIds = useMemo(() => {
    const ids = new Set<CustomTuiAgentId>()
    for (const agent of customDefaultAgents) {
      if (isCustomTuiAgentId(agent.id)) {
        ids.add(agent.id)
      }
    }
    return ids
  }, [customDefaultAgents])
  const [customDraft, setCustomDraft] = useState<CustomAgentDraftState | null>(null)
  const disabledAgents = normalizeDisabledTuiAgents(settings.disabledTuiAgents)

  const setDefault = (id: TuiAgentId | 'blank' | null): void => {
    updateSettings({ defaultTuiAgent: id })
  }

  const toggleEnabled = (id: TuiAgent): void => {
    const latestSettings = useAppStore.getState().settings ?? settings
    updateSettings(buildAgentEnabledSettingsUpdate(latestSettings, id))
  }

  const saveOverride = (id: TuiAgentId, value: string): void => {
    const next = { ...cmdOverrides }
    if (value) {
      next[id] = value
    } else {
      delete next[id]
    }
    updateSettings({ agentCmdOverrides: next })
  }

  const addCustomAgent = (): void => {
    setCustomDraft({
      mode: 'new',
      ...EMPTY_CUSTOM_AGENT_DRAFT
    })
  }

  const editCustomAgent = (agent: CustomTuiAgent): void => {
    setCustomDraft({
      mode: 'edit',
      id: agent.id,
      ...customAgentDraftFromAgent(agent)
    })
  }

  const deleteCustomAgent = (id: CustomTuiAgentId): void => {
    if (customDraft?.mode === 'edit' && customDraft.id === id) {
      setCustomDraft(null)
    }
    updateSettings(buildDeleteCustomAgentSettings(settings, id))
  }

  const updateCustomDraft = (patch: Partial<CustomAgentDraft>): void => {
    setCustomDraft((current) => (current ? { ...current, ...patch } : current))
  }

  const saveCustomDraft = (): void => {
    if (!customDraft) {
      return
    }

    const trimmed = trimCustomAgentDraft(customDraft)
    if (!trimmed.label || !trimmed.command) {
      return
    }

    updateSettings(
      customDraft.mode === 'new'
        ? buildCreateCustomAgentSettings(settings, trimmed)
        : buildUpdateCustomAgentSettings(settings, customDraft.id, trimmed)
    )
    setCustomDraft(null)
  }

  const enabledDetectedAgents = AGENT_CATALOG.filter(
    (a) =>
      (detectedIds === null || detectedIds.has(a.id)) && isTuiAgentEnabled(a.id, disabledAgents)
  )
  const detectedAgents = AGENT_CATALOG.filter((a) => detectedIds === null || detectedIds.has(a.id))
  const undetectedAgents = AGENT_CATALOG.filter(
    (a) => detectedIds !== null && !detectedIds.has(a.id)
  )
  const defaultAgentOptions = [...enabledDetectedAgents, ...customDefaultAgents]

  // Why: 'blank' is an explicit no-agent preference, not an auto fallback,
  // so the Auto pill should only light up when the default is null OR when a
  // selected agent id is no longer detected on PATH.
  const isDefaultSelectable =
    defaultAgent !== null &&
    defaultAgent !== 'blank' &&
    (isCustomTuiAgentId(defaultAgent)
      ? validCustomIds.has(defaultAgent)
      : (detectedIds === null || detectedIds.has(defaultAgent)) &&
        isTuiAgentEnabled(defaultAgent, disabledAgents))
  const isAutoDefault = defaultAgent === null || (defaultAgent !== 'blank' && !isDefaultSelectable)
  const isBlankDefault = defaultAgent === 'blank'

  return (
    <div className="space-y-8">
      <section className="space-y-4">
        <SettingsSubsectionHeader
          title="Default Agent"
          description="Pre-selected agent when opening a new workspace."
        />

        <div className="flex flex-wrap gap-2">
          <DefaultAgentPill active={isAutoDefault} onClick={() => setDefault(null)}>
            {isAutoDefault && <Check className="size-3.5" />}
            Auto
          </DefaultAgentPill>

          {/* Why: users who prefer to open a raw shell by default need a
              first-class "no agent" choice here — without it, the Auto pill
              is the closest option but silently launches the first detected
              agent, which is the opposite of what they want. */}
          <DefaultAgentPill active={isBlankDefault} onClick={() => setDefault('blank')}>
            <Terminal className="size-3.5" />
            No agent (blank terminal)
            {isBlankDefault && <Check className="size-3.5" />}
          </DefaultAgentPill>

          {defaultAgentOptions.map((agent) => {
            const isActive = defaultAgent === agent.id
            return (
              <DefaultAgentPill
                key={agent.id}
                active={isActive}
                onClick={() => setDefault(agent.id)}
              >
                <AgentIcon agent={agent.id} size={14} catalog={mergedCatalog} />
                {agent.label}
                {isActive && <Check className="size-3.5" />}
              </DefaultAgentPill>
            )
          })}
        </div>
      </section>

      <AgentStatusHooksSetting settings={settings} updateSettings={updateSettings} />

      <AgentAwakeSetting settings={settings} updateSettings={updateSettings} />

      {detectedAgents.length > 0 && (
        <section className="space-y-3">
          <SettingsSubsectionHeader
            title={
              <span className="flex items-center gap-2">
                Installed
                <SettingsBadge tone="accent">{detectedAgents.length} detected</SettingsBadge>
              </span>
            }
            action={
              <Button
                type="button"
                variant="ghost"
                size="xs"
                onClick={handleRefresh}
                disabled={isRefreshing}
                title="Re-read your shell PATH and re-detect installed agents"
                className="h-7 gap-1.5 text-xs text-muted-foreground hover:text-foreground"
              >
                <RefreshCw className={cn('size-3', isRefreshing && 'animate-spin')} />
                {isRefreshing ? 'Refreshing…' : 'Refresh'}
              </Button>
            }
          />

          <div className="divide-y divide-border/40">
            {detectedAgents.map((agent) => (
              <AgentRow
                key={agent.id}
                agentId={agent.id}
                label={agent.label}
                homepageUrl={agent.homepageUrl}
                defaultCmd={agent.cmd}
                isDetected
                isEnabled={isTuiAgentEnabled(agent.id, disabledAgents)}
                isDefault={defaultAgent === agent.id}
                cmdOverride={cmdOverrides[agent.id]}
                onSetDefault={() => setDefault(agent.id)}
                onToggleEnabled={() => toggleEnabled(agent.id)}
                onSaveOverride={(v) => saveOverride(agent.id, v)}
              />
            ))}
          </div>
        </section>
      )}

      <section className="space-y-3">
        <SettingsSubsectionHeader
          title={
            <span className="flex items-center gap-2">
              Custom agents
              <SettingsBadge tone="muted">{customAgents.length} presets</SettingsBadge>
            </span>
          }
          action={
            <Button type="button" variant="outline" size="xs" onClick={addCustomAgent}>
              <Plus className="size-3" />
              Add custom
            </Button>
          }
        />

        {customDraft?.mode === 'new' ? (
          <CustomAgentEditor
            draft={customDraft}
            onDraftChange={updateCustomDraft}
            onSave={saveCustomDraft}
            onCancel={() => setCustomDraft(null)}
          />
        ) : null}

        {customAgents.length > 0 ? (
          <div className="divide-y divide-border/40">
            {customAgents.map((agent) => {
              const isEditing = customDraft?.mode === 'edit' && customDraft.id === agent.id
              return (
                <CustomAgentRow
                  key={agent.id}
                  agent={agent}
                  isDefault={defaultAgent === agent.id}
                  isEditing={isEditing}
                  editorDraft={isEditing ? customDraft : null}
                  onSetDefault={() => setDefault(agent.id)}
                  onEdit={() => editCustomAgent(agent)}
                  onCancelEdit={() => setCustomDraft(null)}
                  onDelete={() => deleteCustomAgent(agent.id)}
                  onDraftChange={updateCustomDraft}
                  onSaveDraft={saveCustomDraft}
                />
              )
            })}
          </div>
        ) : (
          <div className="rounded-md border border-dashed border-border/50 px-4 py-5 text-sm text-muted-foreground">
            Add wrappers, company CLIs, or alternate profiles as their own selectable agents.
          </div>
        )}
      </section>

      {undetectedAgents.length > 0 && (
        <section className="space-y-3">
          <SettingsSubsectionHeader
            title={
              <span className="flex items-center gap-2 text-muted-foreground">
                Available to install
                <SettingsBadge tone="muted">{undetectedAgents.length} agents</SettingsBadge>
              </span>
            }
          />

          <div className="divide-y divide-border/40">
            {undetectedAgents.map((agent) => (
              <AgentRow
                key={agent.id}
                agentId={agent.id}
                label={agent.label}
                homepageUrl={agent.homepageUrl}
                defaultCmd={agent.cmd}
                isDetected={false}
                isEnabled={isTuiAgentEnabled(agent.id, disabledAgents)}
                isDefault={false}
                cmdOverride={undefined}
                onSetDefault={() => {}}
                onToggleEnabled={() => toggleEnabled(agent.id)}
                onSaveOverride={() => {}}
              />
            ))}
          </div>
        </section>
      )}

      {detectedIds === null && (
        <div className="flex items-center justify-center rounded-md border border-dashed border-border/50 py-6 text-sm text-muted-foreground">
          Detecting installed agents…
        </div>
      )}
    </div>
  )
}

export function AgentStatusHooksSetting({
  settings,
  updateSettings
}: AgentsPaneProps): React.JSX.Element {
  const enabled = settings.agentStatusHooksEnabled !== false
  return (
    <section className="space-y-3">
      <SettingsSwitchRow
        label={AGENT_STATUS_HOOKS_TITLE}
        description={AGENT_STATUS_HOOKS_DESCRIPTION}
        checked={enabled}
        onChange={() =>
          updateSettings({
            agentStatusHooksEnabled: !enabled
          })
        }
        ariaLabel={AGENT_STATUS_HOOKS_TITLE}
      />
    </section>
  )
}
