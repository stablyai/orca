/* eslint-disable max-lines -- Why: Agents settings is an existing dense pane; this patch keeps custom-agent CRUD adjacent to built-ins to avoid splitting the settings write contract across files. */
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
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { cn } from '@/lib/utils'
import { AgentAwakeSetting } from './AgentAwakeSetting'

export { AGENTS_PANE_SEARCH_ENTRIES } from './agents-search'

type AgentsPaneProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
}

const EMPTY_CUSTOM_TUI_AGENTS: readonly CustomTuiAgent[] = []

type AgentRowProps = {
  agentId: TuiAgentId
  label: string
  homepageUrl?: string
  defaultCmd: string
  isDetected: boolean
  isDefault: boolean
  cmdOverride: string | undefined
  onSetDefault: () => void
  onSaveOverride: (value: string) => void
}

type AgentCommandOverrideInputProps = {
  defaultCmd: string
  cmdOverride: string | undefined
  onSaveOverride: (value: string) => void
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

type CustomAgentEditorProps = {
  draft: CustomAgentDraftState
  onDraftChange: (patch: Partial<CustomAgentDraft>) => void
  onSave: () => void
  onCancel: () => void
  /** When true, the editor renders as the expanded body of an existing row
   *  instead of as a standalone card. The wrapping <form> drops its border
   *  and the row header above already shows the agent identity. */
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

  const fields = (
    <div className="space-y-3">
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
          Executable Orca looks for on PATH to mark this preset as installed — for example{' '}
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
    </div>
  )

  if (inline) {
    return (
      <form
        onSubmit={(event) => {
          event.preventDefault()
          if (isSaveEnabled) {
            onSave()
          }
        }}
        className="border-t border-border/40 px-4 py-3"
      >
        {fields}
      </form>
    )
  }

  return (
    <form
      className="rounded-xl border border-border/60 bg-card/60"
      onSubmit={(event) => {
        event.preventDefault()
        if (isSaveEnabled) {
          onSave()
        }
      }}
    >
      <div className="flex items-start gap-3 px-4 py-3">
        <div className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-border/50 bg-background/60 text-muted-foreground">
          <Terminal className="size-4" />
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold leading-none">New custom agent</span>
            <span className="inline-flex items-center rounded-full border border-border/40 bg-muted/30 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
              Custom
            </span>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            Save a launch command as its own selectable agent preset.
          </p>
        </div>
      </div>

      <div className="border-t border-border/40 px-4 py-3">{fields}</div>
    </form>
  )
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
    // Why: borrow the icon of the underlying CLI when a custom preset wraps a
    // built-in (e.g. `codex --profile work`), matching how the merged catalog
    // resolves icons elsewhere in the app.
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
    <div className="group rounded-xl border border-border/60 bg-card/60 transition-all">
      <div className="flex items-center gap-3 px-4 py-3">
        <div className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-border/50 bg-background/60">
          <AgentIcon agent={agent.id} size={18} catalog={catalog} />
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-semibold leading-none">{agent.label}</span>
            <span
              className={cn(
                'inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10px] font-medium',
                commandReady
                  ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
                  : 'border-border/40 bg-muted/30 text-muted-foreground'
              )}
            >
              {commandReady ? (
                <>
                  <span className="size-1.5 rounded-full bg-emerald-500" />
                  Ready
                </>
              ) : (
                'Missing command'
              )}
            </span>
          </div>
          <div className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground">
            {agent.command || 'No launch command'}
          </div>
          {agent.detectCmd ? (
            <div className="mt-1 truncate text-[11px] text-muted-foreground">
              Detect command:{' '}
              <span className="font-mono text-foreground/70">{agent.detectCmd}</span>
            </div>
          ) : null}
        </div>

        <div className="flex shrink-0 items-center gap-1">
          {commandReady ? (
            <button
              type="button"
              onClick={onSetDefault}
              title={isDefault ? 'Default agent' : 'Set as default'}
              className={cn(
                'flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium transition-colors',
                isDefault
                  ? 'bg-foreground/10 text-foreground ring-1 ring-foreground/20'
                  : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground'
              )}
            >
              {isDefault && <Check className="size-3" />}
              {isDefault ? 'Default' : 'Set default'}
            </button>
          ) : null}
          {/* Why: chevron-on-edit mirrors the Installed agent row pattern —
              clicking expands the same card in place rather than spawning a
              sibling editor card below. */}
          <button
            type="button"
            onClick={isEditing ? onCancelEdit : onEdit}
            aria-label={isEditing ? `Close editor for ${agent.label}` : `Edit ${agent.label}`}
            title={isEditing ? 'Close editor' : `Edit ${agent.label}`}
            className={cn(
              'flex size-7 items-center justify-center rounded-lg transition-colors',
              isEditing
                ? 'bg-muted/60 text-foreground'
                : 'text-muted-foreground hover:bg-muted/50 hover:text-foreground'
            )}
          >
            <Pencil className="size-3.5" />
          </button>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            onClick={onDelete}
            aria-label={`Delete ${agent.label}`}
            title={`Delete ${agent.label}`}
            className="text-destructive hover:text-destructive"
          >
            <Trash2 className="size-3.5" />
          </Button>
          <button
            type="button"
            onClick={isEditing ? onCancelEdit : onEdit}
            aria-hidden={!isEditing}
            tabIndex={-1}
            className="flex size-7 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
          >
            <ChevronDown
              className={cn('size-3.5 transition-transform', isEditing && 'rotate-180')}
            />
          </button>
        </div>
      </div>

      {isEditing && editorDraft ? (
        <CustomAgentEditor
          inline
          draft={editorDraft}
          onDraftChange={onDraftChange}
          onSave={onSaveDraft}
          onCancel={onCancelEdit}
        />
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
  isDefault,
  cmdOverride,
  onSetDefault,
  onSaveOverride
}: AgentRowProps): React.JSX.Element {
  const [cmdOpen, setCmdOpen] = useState(Boolean(cmdOverride))

  return (
    <div
      className={cn(
        'group rounded-xl border transition-all',
        isDetected ? 'border-border/60 bg-card/60' : 'border-border/30 bg-card/20 opacity-60'
      )}
    >
      <div className="flex items-center gap-3 px-4 py-3">
        {/* Icon */}
        <div className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-border/50 bg-background/60">
          <AgentIcon agent={agentId} size={18} />
        </div>

        {/* Name + status */}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold leading-none">{label}</span>
            {isDetected ? (
              <span className="inline-flex items-center gap-1 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700 dark:text-emerald-300">
                <span className="size-1.5 rounded-full bg-emerald-500" />
                Detected
              </span>
            ) : (
              <span className="inline-flex items-center gap-1 rounded-full border border-border/40 bg-muted/30 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                Not installed
              </span>
            )}
          </div>
          <div className="mt-0.5 font-mono text-[11px] text-muted-foreground">
            {cmdOverride ? (
              <span>
                <span className="text-muted-foreground/60 line-through">{defaultCmd}</span>
                <span className="ml-1.5 text-foreground/70">{cmdOverride}</span>
              </span>
            ) : (
              defaultCmd
            )}
          </div>
        </div>

        {/* Actions */}
        <div className="flex shrink-0 items-center gap-1">
          {/* Set as default — only for detected agents */}
          {isDetected && (
            <button
              type="button"
              onClick={onSetDefault}
              title={isDefault ? 'Default agent' : 'Set as default'}
              className={cn(
                'flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium transition-colors',
                isDefault
                  ? 'bg-foreground/10 text-foreground ring-1 ring-foreground/20'
                  : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground'
              )}
            >
              {isDefault && <Check className="size-3" />}
              {isDefault ? 'Default' : 'Set default'}
            </button>
          )}

          {/* Customize command — only for detected agents */}
          {isDetected && (
            <button
              type="button"
              onClick={() => setCmdOpen((prev) => !prev)}
              title="Customize command"
              className={cn(
                'flex size-7 items-center justify-center rounded-lg transition-colors',
                cmdOpen || cmdOverride
                  ? 'bg-muted/60 text-foreground'
                  : 'text-muted-foreground hover:bg-muted/50 hover:text-foreground'
              )}
            >
              <Terminal className="size-3.5" />
            </button>
          )}

          {/* Homepage link (built-ins always carry one; custom presets may omit) */}
          {homepageUrl ? (
            <a
              href={homepageUrl}
              target="_blank"
              rel="noopener noreferrer"
              title={isDetected ? 'Docs' : 'Install'}
              className="flex size-7 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
            >
              <ExternalLink className="size-3.5" />
            </a>
          ) : null}

          {/* Expand chevron for cmd override */}
          {isDetected && (
            <button
              type="button"
              onClick={() => setCmdOpen((prev) => !prev)}
              className="flex size-7 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
            >
              <ChevronDown
                className={cn('size-3.5 transition-transform', cmdOpen && 'rotate-180')}
              />
            </button>
          )}
        </div>
      </div>

      {/* Command override row */}
      {isDetected && cmdOpen && (
        <div className="border-t border-border/40 px-4 py-3">
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
  const validCustomIds = useMemo(() => {
    const ids = new Set<CustomTuiAgentId>()
    for (const agent of mergedCatalog) {
      if (agent.isCustom && isCustomTuiAgentId(agent.id)) {
        ids.add(agent.id)
      }
    }
    return ids
  }, [mergedCatalog])
  const [customDraft, setCustomDraft] = useState<CustomAgentDraftState | null>(null)

  const setDefault = (id: TuiAgentId | 'blank' | null): void => {
    updateSettings({ defaultTuiAgent: id })
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

    // Why: new custom-agent ids are generated only on Save so the slug reflects
    // the user-entered name instead of a temporary "Untitled" draft.
    updateSettings(
      customDraft.mode === 'new'
        ? buildCreateCustomAgentSettings(settings, trimmed)
        : buildUpdateCustomAgentSettings(settings, customDraft.id, trimmed)
    )
    setCustomDraft(null)
  }

  const detectedAgents = AGENT_CATALOG.filter((a) => detectedIds === null || detectedIds.has(a.id))
  const undetectedAgents = AGENT_CATALOG.filter(
    (a) => detectedIds !== null && !detectedIds.has(a.id)
  )
  const defaultAgentOptions = [
    ...detectedAgents,
    ...mergedCatalog.filter((agent) => agent.isCustom)
  ]

  // Why: 'blank' is an explicit no-agent preference, not an auto fallback,
  // so the Auto pill should only light up when the default is null OR when a
  // selected agent id is no longer detected on PATH.
  const isDefaultSelectable =
    defaultAgent !== null &&
    defaultAgent !== 'blank' &&
    (isCustomTuiAgentId(defaultAgent)
      ? validCustomIds.has(defaultAgent)
      : detectedIds === null || detectedIds.has(defaultAgent))
  const isAutoDefault = defaultAgent === null || (defaultAgent !== 'blank' && !isDefaultSelectable)
  const isBlankDefault = defaultAgent === 'blank'

  return (
    <div className="space-y-8">
      {/* Default agent picker */}
      <section className="space-y-4">
        <div className="space-y-1">
          <h3 className="text-sm font-semibold">Default Agent</h3>
          <p className="text-xs text-muted-foreground">
            Pre-selected agent when opening a new workspace.
          </p>
        </div>

        <div className="flex flex-wrap gap-2">
          {/* Auto option */}
          <button
            type="button"
            onClick={() => setDefault(null)}
            className={cn(
              'flex items-center gap-2 rounded-xl border px-3 py-2 text-sm transition-all',
              isAutoDefault
                ? 'border-foreground/20 bg-foreground/8 font-medium ring-1 ring-foreground/15'
                : 'border-border/50 bg-muted/30 text-muted-foreground hover:border-border hover:bg-muted/50 hover:text-foreground'
            )}
          >
            {isAutoDefault && <Check className="size-3.5" />}
            Auto
          </button>

          {/* Why: users who prefer to open a raw shell by default need a
              first-class "no agent" choice here — without it, the Auto pill
              is the closest option but silently launches the first detected
              agent, which is the opposite of what they want. */}
          <button
            type="button"
            onClick={() => setDefault('blank')}
            className={cn(
              'flex items-center gap-2 rounded-xl border px-3 py-2 text-sm transition-all',
              isBlankDefault
                ? 'border-foreground/20 bg-foreground/8 font-medium ring-1 ring-foreground/15'
                : 'border-border/50 bg-muted/30 text-muted-foreground hover:border-border hover:bg-muted/50 hover:text-foreground'
            )}
          >
            <Terminal className="size-3.5" />
            No agent (blank terminal)
            {isBlankDefault && <Check className="size-3.5" />}
          </button>

          {/* Detected built-ins and ready custom-agent pills */}
          {defaultAgentOptions.map((agent) => {
            const isActive = defaultAgent === agent.id
            return (
              <button
                key={agent.id}
                type="button"
                onClick={() => setDefault(agent.id)}
                className={cn(
                  'flex items-center gap-2 rounded-xl border px-3 py-2 text-sm transition-all',
                  isActive
                    ? 'border-foreground/20 bg-foreground/8 font-medium ring-1 ring-foreground/15'
                    : 'border-border/50 bg-muted/30 text-muted-foreground hover:border-border hover:bg-muted/50 hover:text-foreground'
                )}
              >
                <AgentIcon agent={agent.id} size={14} catalog={mergedCatalog} />
                {agent.label}
                {isActive && <Check className="size-3.5" />}
              </button>
            )
          })}
        </div>
      </section>

      <AgentAwakeSetting settings={settings} updateSettings={updateSettings} />

      {/* Detected agents */}
      {detectedAgents.length > 0 && (
        <section className="space-y-3">
          <div className="flex items-center gap-3">
            <h3 className="text-sm font-semibold">Installed</h3>
            <span className="rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-medium text-emerald-700 dark:text-emerald-300">
              {detectedAgents.length} detected
            </span>
            <button
              type="button"
              onClick={handleRefresh}
              disabled={isRefreshing}
              title="Re-read your shell PATH and re-detect installed agents"
              className={cn(
                'ml-auto flex items-center gap-1.5 rounded-lg px-2 py-1 text-[11px] font-medium transition-colors',
                isRefreshing
                  ? 'text-muted-foreground/60'
                  : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground'
              )}
            >
              <RefreshCw className={cn('size-3', isRefreshing && 'animate-spin')} />
              {isRefreshing ? 'Refreshing…' : 'Refresh'}
            </button>
          </div>

          <div className="space-y-2">
            {detectedAgents.map((agent) => (
              <AgentRow
                key={agent.id}
                agentId={agent.id}
                label={agent.label}
                homepageUrl={agent.homepageUrl}
                defaultCmd={agent.cmd}
                isDetected
                isDefault={defaultAgent === agent.id}
                cmdOverride={cmdOverrides[agent.id]}
                onSetDefault={() => setDefault(agent.id)}
                onSaveOverride={(v) => saveOverride(agent.id, v)}
              />
            ))}
          </div>
        </section>
      )}

      <section className="space-y-3">
        <div className="flex items-center gap-3">
          <h3 className="text-sm font-semibold">Custom agents</h3>
          <span className="rounded-full border border-border/40 bg-muted/30 px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
            {customAgents.length} presets
          </span>
          <Button
            type="button"
            variant="outline"
            size="xs"
            onClick={addCustomAgent}
            className="ml-auto"
          >
            <Plus className="size-3" />
            Add custom
          </Button>
        </div>

        {customDraft?.mode === 'new' ? (
          <CustomAgentEditor
            draft={customDraft}
            onDraftChange={updateCustomDraft}
            onSave={saveCustomDraft}
            onCancel={() => setCustomDraft(null)}
          />
        ) : null}

        {customAgents.length > 0 ? (
          <div className="space-y-2">
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
          <div className="rounded-xl border border-dashed border-border/50 px-4 py-5 text-sm text-muted-foreground">
            Add wrappers, company CLIs, or alternate profiles as their own selectable agents.
          </div>
        )}
      </section>

      {/* Undetected agents */}
      {undetectedAgents.length > 0 && (
        <section className="space-y-3">
          <div className="flex items-center gap-3">
            <h3 className="text-sm font-semibold text-muted-foreground">Available to install</h3>
            <span className="rounded-full border border-border/40 bg-muted/30 px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
              {undetectedAgents.length} agents
            </span>
          </div>

          <div className="space-y-2">
            {undetectedAgents.map((agent) => (
              <AgentRow
                key={agent.id}
                agentId={agent.id}
                label={agent.label}
                homepageUrl={agent.homepageUrl}
                defaultCmd={agent.cmd}
                isDetected={false}
                isDefault={false}
                cmdOverride={undefined}
                onSetDefault={() => {}}
                onSaveOverride={() => {}}
              />
            ))}
          </div>
        </section>
      )}

      {detectedIds === null && (
        <div className="flex items-center justify-center rounded-xl border border-dashed border-border/50 py-8 text-sm text-muted-foreground">
          Detecting installed agents…
        </div>
      )}
    </div>
  )
}
