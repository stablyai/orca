/* eslint-disable max-lines -- Why: the Agents pane keeps catalog rows, default
   selection, per-agent controls, and runtime location together so settings
   reconciliation stays visible in one file. */
import { useId, useMemo, useState } from 'react'
import {
  AlertTriangle,
  Check,
  ChevronDown,
  ExternalLink,
  FolderOpen,
  Info,
  Pencil,
  Plus,
  RefreshCw,
  Terminal,
  Trash2
} from 'lucide-react'
import type { CustomAgent, GlobalSettings, TuiAgent } from '../../../../shared/types'
import { getAgentCatalog, AgentIcon } from '@/lib/agent-catalog'
import { useDetectedAgents, type AgentDetectionTarget } from '@/hooks/useDetectedAgents'
import { useAppStore } from '@/store'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { cn } from '@/lib/utils'
import { AgentAwakeSetting } from './AgentAwakeSetting'
import { AgentCacheTimerSection } from './AgentCacheTimerSection'
import { AgentRuntimeSetting } from './AgentRuntimeSetting'
import {
  AgentSessionSourceHomeInput,
  buildCodexSessionSourceHomeControl,
  type AgentSessionSourceHomeControl
} from './codex-session-source-home-control'
import {
  getAgentGeneratedTabTitlesDescription,
  getAgentGeneratedTabTitlesTitle
} from './agent-generated-tab-title-copy'
import { getAgentStatusHooksDescription, getAgentStatusHooksTitle } from './agent-status-hooks-copy'
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
import {
  getTuiAgentDefaultArgs,
  getTuiAgentDefaultEnv,
  resolveTuiAgentLaunchArgs,
  resolveTuiAgentLaunchEnv
} from '../../../../shared/tui-agent-launch-defaults'
import {
  applyAgentPermissionMode,
  resolveAgentPermissionModeSummary,
  type AgentPermissionMode
} from '../../../../shared/tui-agent-permissions'
import { getSettingOwnershipSummary } from './setting-ownership'
import { translate } from '@/i18n/i18n'
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip'
import { parseAgentDefaultEnvDraft, stringifyAgentDefaultEnvDraft } from './agent-default-env-draft'

export { getAgentsPaneSearchEntries } from './agents-search'

type AgentsPaneProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void | Promise<void>
  wslSupportedPlatform?: boolean
  wslAvailable?: boolean
  wslDistros?: string[]
  wslCapabilitiesLoading?: boolean
}

type AgentAvailabilityUpdateQueueOptions = {
  getSettings: () => GlobalSettings | null | undefined
  fallbackSettings: GlobalSettings
  updateSettings: AgentsPaneProps['updateSettings']
  agentId: TuiAgent
  enabled: boolean
}

type AgentRowProps = {
  agentId: TuiAgent
  label: string
  homepageUrl: string
  defaultCmd: string
  defaultArgs: string
  defaultEnv: Record<string, string>
  isDetected: boolean
  isEnabled: boolean
  isDefault: boolean
  cmdOverride: string | undefined
  argsOverride: string
  envOverride: Record<string, string>
  onSetDefault: () => void
  onSetEnabled: (enabled: boolean) => void
  onSaveOverride: (value: string) => void
  onSaveArgs: (value: string) => void
  onSaveEnv: (value: Record<string, string>) => void
  /** Codex-only: current runtime scope label + persisted history-source override. */
  sessionSourceHome?: AgentSessionSourceHomeControl
}

type AgentCommandOverrideInputProps = {
  defaultCmd: string
  cmdOverride: string | undefined
  onSaveOverride: (value: string) => void
}

type AgentDefaultArgsInputProps = {
  defaultArgs: string
  argsOverride: string
  onSaveArgs: (value: string) => void
}

type AgentDefaultEnvInputProps = {
  defaultEnv: Record<string, string>
  envOverride: Record<string, string>
  onSaveEnv: (value: Record<string, string>) => void
}

type AgentAvailability = 'enabled' | 'disabled'

type AgentAvailabilityControlProps = {
  label: string
  isEnabled: boolean
  onSetEnabled: (enabled: boolean) => void
}

type AgentPermissionsSettingProps = {
  mode: AgentPermissionMode
  onChange: (mode: Exclude<AgentPermissionMode, 'mixed'>) => void
}

export function buildAgentAvailabilitySettingsUpdate(
  settings: Pick<GlobalSettings, 'defaultTuiAgent' | 'disabledTuiAgents'>,
  id: TuiAgent,
  enabled: boolean
): Pick<GlobalSettings, 'disabledTuiAgents'> & Partial<Pick<GlobalSettings, 'defaultTuiAgent'>> {
  const latestDisabled = normalizeDisabledTuiAgents(settings.disabledTuiAgents)
  const nextDisabled = enabled
    ? latestDisabled.filter((agent) => agent !== id)
    : latestDisabled.includes(id)
      ? latestDisabled
      : [...latestDisabled, id]

  return {
    disabledTuiAgents: nextDisabled,
    ...(settings.defaultTuiAgent === id && !enabled ? { defaultTuiAgent: null } : {})
  }
}

export function createAgentAvailabilityUpdateQueue(): (
  options: AgentAvailabilityUpdateQueueOptions
) => Promise<void> {
  let pendingUpdate: Promise<unknown> = Promise.resolve()

  return ({ getSettings, fallbackSettings, updateSettings, agentId, enabled }) => {
    // Why: serialize full-array replacements so each write sees the store after
    // the previous IPC has reconciled, while preserving the user's requested state.
    pendingUpdate = pendingUpdate
      .catch(() => {})
      .then(() =>
        updateSettings(
          buildAgentAvailabilitySettingsUpdate(getSettings() ?? fallbackSettings, agentId, enabled)
        )
      )
    return pendingUpdate.then(() => undefined)
  }
}

const enqueueAgentAvailabilityUpdate = createAgentAvailabilityUpdateQueue()

export function AgentAvailabilityControl({
  label,
  isEnabled,
  onSetEnabled
}: AgentAvailabilityControlProps): React.JSX.Element {
  const value: AgentAvailability = isEnabled ? 'enabled' : 'disabled'

  return (
    <SettingsSegmentedControl<AgentAvailability>
      value={value}
      onChange={(next) => {
        if (next !== value) {
          onSetEnabled(next === 'enabled')
        }
      }}
      ariaLabel={translate(
        'auto.components.settings.AgentsPane.1c9a9679ec',
        '{{value0}} availability',
        { value0: label }
      )}
      size="sm"
      options={[
        {
          value: 'enabled',
          label: translate('auto.components.settings.AgentsPane.d4d2a45d63', 'Enabled')
        },
        {
          value: 'disabled',
          label: translate('auto.components.settings.AgentsPane.8dc0192e48', 'Disabled')
        }
      ]}
    />
  )
}

export function AgentPermissionsSetting({
  mode,
  onChange
}: AgentPermissionsSettingProps): React.JSX.Element {
  const visibleMode: Exclude<AgentPermissionMode, 'mixed'> = mode === 'manual' ? 'manual' : 'yolo'
  return (
    <section className="space-y-3">
      <SettingsSubsectionHeader
        title={
          <span className="flex items-center gap-2">
            {translate('auto.components.settings.AgentsPane.agentPermissions', 'Agent Permissions')}
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  aria-label={translate(
                    'auto.components.settings.AgentsPane.agentPermissionsInfo',
                    'Agent permissions info'
                  )}
                  className="grid size-5 place-items-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
                >
                  <Info className="size-3.5" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="top" sideOffset={6}>
                {translate(
                  'auto.components.settings.AgentsPane.agentPermissionsTooltip',
                  "Doesn't apply to agents where you've overridden launch arguments."
                )}
              </TooltipContent>
            </Tooltip>
          </span>
        }
        description={translate(
          'auto.components.settings.AgentsPane.agentPermissionsDescription',
          'Choose whether Orca launches agents with fewer permission prompts or with manual checks.'
        )}
        action={
          <SettingsSegmentedControl<AgentPermissionMode>
            value={visibleMode}
            onChange={(nextMode) => {
              if (nextMode !== 'mixed') {
                onChange(nextMode)
              }
            }}
            ariaLabel={translate(
              'auto.components.settings.AgentsPane.agentPermissions',
              'Agent Permissions'
            )}
            size="sm"
            options={[
              {
                value: 'yolo',
                label: translate('auto.components.settings.AgentsPane.agentPermissionsYolo', 'Yolo')
              },
              {
                value: 'manual',
                label: translate(
                  'auto.components.settings.AgentsPane.agentPermissionsManual',
                  'Manual'
                )
              }
            ]}
          />
        }
      />
    </section>
  )
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
    <div className="flex flex-col gap-1">
      <span className="text-xs text-muted-foreground">
        {translate('auto.components.settings.AgentsPane.2e45ca29b6', 'Command')}
      </span>
      <div className="flex items-center gap-2">
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
            {translate('auto.components.settings.AgentsPane.5200dac9da', 'Reset')}
          </Button>
        )}
      </div>
    </div>
  )
}

function AgentDefaultArgsInput({
  defaultArgs,
  argsOverride,
  onSaveArgs
}: AgentDefaultArgsInputProps): React.JSX.Element {
  const draftSeed = argsOverride
  const [argsDraft, setArgsDraft] = useState(draftSeed)

  const commitArgs = (): void => {
    onSaveArgs(argsDraft.trim())
  }

  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs text-muted-foreground">
        {translate('auto.components.settings.AgentsPane.cfb3f35775', 'Arguments')}
      </span>
      <div className="flex items-center gap-2">
        <Input
          value={argsDraft}
          onChange={(e) => setArgsDraft(e.target.value)}
          onBlur={commitArgs}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              commitArgs()
              e.currentTarget.blur()
            }
            if (e.key === 'Escape') {
              setArgsDraft(draftSeed)
              e.currentTarget.blur()
            }
          }}
          placeholder={
            defaultArgs ||
            translate('auto.components.settings.AgentsPane.6f99bf5dd0', 'No default arguments')
          }
          spellCheck={false}
          className="h-7 flex-1 font-mono text-xs"
        />
        {argsOverride !== defaultArgs && (
          <Button
            type="button"
            variant="ghost"
            size="xs"
            onClick={() => {
              onSaveArgs(defaultArgs)
              setArgsDraft(defaultArgs)
            }}
            className="h-7 shrink-0 text-xs text-muted-foreground hover:text-foreground"
          >
            {translate('auto.components.settings.AgentsPane.5200dac9da', 'Reset')}
          </Button>
        )}
      </div>
    </div>
  )
}

function AgentDefaultEnvInput({
  defaultEnv,
  envOverride,
  onSaveEnv
}: AgentDefaultEnvInputProps): React.JSX.Element {
  const defaultEnvText = stringifyAgentDefaultEnvDraft(defaultEnv)
  const draftSeed = stringifyAgentDefaultEnvDraft(envOverride)
  const [envDraft, setEnvDraft] = useState(draftSeed)
  const [envDraftTooLarge, setEnvDraftTooLarge] = useState(false)
  const envDraftErrorId = useId()

  const commitEnv = (): void => {
    const parsedDraft = parseAgentDefaultEnvDraft(envDraft)
    setEnvDraftTooLarge(parsedDraft.tooLarge)
    if (parsedDraft.tooLarge) {
      return
    }
    onSaveEnv(parsedDraft.env)
  }

  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs text-muted-foreground">
        {translate('auto.components.settings.AgentsPane.8fbe1f37c1', 'Environment')}
      </span>
      <div className="flex items-center gap-2">
        <Input
          value={envDraft}
          onChange={(e) => {
            setEnvDraft(e.target.value)
            if (envDraftTooLarge) {
              setEnvDraftTooLarge(false)
            }
          }}
          onBlur={commitEnv}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              commitEnv()
              e.currentTarget.blur()
            }
            if (e.key === 'Escape') {
              setEnvDraft(draftSeed)
              setEnvDraftTooLarge(false)
              e.currentTarget.blur()
            }
          }}
          placeholder={
            defaultEnvText ||
            translate('auto.components.settings.AgentsPane.2d133152fa', 'No default environment')
          }
          spellCheck={false}
          aria-invalid={envDraftTooLarge || undefined}
          aria-describedby={envDraftTooLarge ? envDraftErrorId : undefined}
          className={cn(
            'h-7 flex-1 font-mono text-xs',
            envDraftTooLarge && 'border-destructive/50 bg-destructive/5'
          )}
        />
        {draftSeed !== defaultEnvText && (
          <Button
            type="button"
            variant="ghost"
            size="xs"
            onClick={() => {
              onSaveEnv(defaultEnv)
              setEnvDraft(defaultEnvText)
              setEnvDraftTooLarge(false)
            }}
            className="h-7 shrink-0 text-xs text-muted-foreground hover:text-foreground"
          >
            {translate('auto.components.settings.AgentsPane.5200dac9da', 'Reset')}
          </Button>
        )}
      </div>
      {envDraftTooLarge && (
        <p id={envDraftErrorId} className="mt-1 text-[11px] text-destructive">
          {translate(
            'auto.components.settings.AgentsPane.3f1bdf3cb4',
            'Environment text is too large to parse safely.'
          )}
        </p>
      )}
    </div>
  )
}

function AgentRow({
  agentId,
  label,
  homepageUrl,
  defaultCmd,
  defaultArgs,
  defaultEnv,
  isDetected,
  isEnabled,
  isDefault,
  cmdOverride,
  argsOverride,
  envOverride,
  onSetDefault,
  onSetEnabled,
  onSaveOverride,
  onSaveArgs,
  onSaveEnv,
  sessionSourceHome
}: AgentRowProps): React.JSX.Element {
  const envSummary = stringifyAgentDefaultEnvDraft(envOverride)
  const defaultEnvSummary = stringifyAgentDefaultEnvDraft(defaultEnv)
  const [cmdOpen, setCmdOpen] = useState(
    Boolean(cmdOverride) || argsOverride !== defaultArgs || envSummary !== defaultEnvSummary
  )

  return (
    <div className={cn('py-3', !isDetected && 'opacity-70')}>
      <div className="flex flex-wrap items-start gap-3">
        <div className="flex size-7 shrink-0 items-center justify-center rounded-md border border-border/50 bg-background/50">
          <AgentIcon agent={agentId} size={16} />
        </div>

        <div className="min-w-0 flex-1 sm:min-w-[12rem]">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium leading-none">{label}</span>
            {!isEnabled && (
              <SettingsBadge tone="muted">
                {translate('auto.components.settings.AgentsPane.8dc0192e48', 'Disabled')}
              </SettingsBadge>
            )}
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
            {argsOverride && <span className="ml-1.5 text-foreground/70">{argsOverride}</span>}
            {envSummary && <span className="ml-1.5 text-foreground/60">{envSummary}</span>}
          </div>
        </div>

        <div className="ml-auto grid shrink-0 grid-cols-[max-content_6.5rem_1.75rem_1.75rem] items-center gap-1.5">
          <AgentAvailabilityControl
            label={label}
            isEnabled={isEnabled}
            onSetEnabled={onSetEnabled}
          />

          <div className="flex justify-start">
            {isDetected && isEnabled && (
              <Button
                type="button"
                variant={isDefault ? 'secondary' : 'ghost'}
                size="xs"
                onClick={onSetDefault}
                title={
                  isDefault
                    ? translate('auto.components.settings.AgentsPane.d7625cf8b2', 'Default agent')
                    : translate('auto.components.settings.AgentsPane.5f986a9b92', 'Set as default')
                }
                className="h-7 w-full justify-center gap-1 text-xs"
              >
                {isDefault && <Check className="size-3" />}
                {isDefault
                  ? translate('auto.components.settings.AgentsPane.24e032fa34', 'Default')
                  : translate('auto.components.settings.AgentsPane.959b67385b', 'Set default')}
              </Button>
            )}
          </div>

          <a
            href={homepageUrl}
            target="_blank"
            rel="noopener noreferrer"
            title={
              isDetected
                ? translate('auto.components.settings.AgentsPane.fe4d630c94', 'Docs')
                : translate('auto.components.settings.AgentsPane.f95b5c79b8', 'Install')
            }
            className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
          >
            <ExternalLink className="size-3.5" />
          </a>

          <div className="flex size-7 items-center justify-center">
            {isDetected && (
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                onClick={() => setCmdOpen((prev) => !prev)}
                aria-label={
                  cmdOpen
                    ? translate(
                        'auto.components.settings.AgentsPane.cea7d97be1',
                        'Collapse command override'
                      )
                    : translate(
                        'auto.components.settings.AgentsPane.dc4a2ffdc0',
                        'Expand command override'
                      )
                }
                className="size-7 text-muted-foreground hover:text-foreground"
              >
                <ChevronDown
                  className={cn('size-3.5 transition-transform', cmdOpen && 'rotate-180')}
                />
              </Button>
            )}
          </div>
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
          <div className="mt-2">
            <AgentDefaultArgsInput
              key={`${agentId}:${argsOverride}`}
              defaultArgs={defaultArgs}
              argsOverride={argsOverride}
              onSaveArgs={onSaveArgs}
            />
          </div>
          {(defaultEnvSummary || envSummary) && (
            <div className="mt-2">
              <AgentDefaultEnvInput
                key={`${agentId}:${envSummary}`}
                defaultEnv={defaultEnv}
                envOverride={envOverride}
                onSaveEnv={onSaveEnv}
              />
            </div>
          )}
          {sessionSourceHome && (
            <div className="mt-2">
              <AgentSessionSourceHomeInput
                key={`${agentId}:${sessionSourceHome.runtimeLabel}:${sessionSourceHome.value}`}
                runtimeLabel={sessionSourceHome.runtimeLabel}
                value={sessionSourceHome.value}
                onSave={sessionSourceHome.onSave}
              />
            </div>
          )}
          <p className="mt-2 text-[11px] text-muted-foreground">
            {translate(
              'auto.components.settings.AgentsPane.f9f127d664',
              'Override the binary path or name, and edit the default launch arguments or environment for this agent.'
            )}
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

function CustomAgentDefaultPillIcon({ agent }: { agent: CustomAgent }): React.JSX.Element {
  if (agent.iconUrl) {
    return (
      <img
        src={agent.iconUrl}
        width={14}
        height={14}
        alt=""
        aria-hidden
        style={{ borderRadius: 2 }}
      />
    )
  }
  if (agent.faviconDomain) {
    return (
      <img
        src={`https://www.google.com/s2/favicons?domain=${agent.faviconDomain}&sz=64`}
        width={14}
        height={14}
        alt=""
        aria-hidden
        style={{ borderRadius: 2 }}
      />
    )
  }
  return (
    <span className="flex size-3.5 shrink-0 items-center justify-center rounded-[3px] bg-muted text-[8px] font-bold text-muted-foreground">
      {agent.label.charAt(0).toUpperCase()}
    </span>
  )
}

export function AgentsPane({
  settings,
  updateSettings,
  wslSupportedPlatform,
  wslAvailable,
  wslDistros,
  wslCapabilitiesLoading
}: AgentsPaneProps): React.JSX.Element {
  // Why: the Active Server routes agent launches and provider checks through
  // that server, so this pane must list what THAT host can launch — detecting
  // on the client showed a Windows machine's agents while paired to a Linux
  // server (the enable/disable/default toggles below stay client settings).
  const activeServerEnvironmentId = settings.activeRuntimeEnvironmentId?.trim() || null
  const agentDetectionTarget = useMemo<AgentDetectionTarget>(
    () =>
      activeServerEnvironmentId
        ? { kind: 'runtime', environmentId: activeServerEnvironmentId }
        : { kind: 'local' },
    [activeServerEnvironmentId]
  )
  const {
    detectedIds: detectedList,
    detectionFailed,
    isRefreshing,
    refresh: refreshTargetAgents
  } = useDetectedAgents(agentDetectionTarget)
  const refreshLocalAgents = useAppStore((s) => s.refreshDetectedAgents)
  const activeServerName = useAppStore((s) =>
    activeServerEnvironmentId
      ? (s.runtimeEnvironments.find((environment) => environment.id === activeServerEnvironmentId)
          ?.name ?? null)
      : null
  )
  // Why: refresh re-spawns the target host's login shell to re-capture PATH
  // (preflight:refreshAgents). This handles the "installed a new CLI, Orca
  // doesn't see it yet" case without a restart.
  const handleRefresh = (): void => {
    void refreshTargetAgents()
  }
  const detectedIds = useMemo<Set<string> | null>(
    () => (detectedList ? new Set(detectedList) : null),
    [detectedList]
  )

  const defaultAgent = settings.defaultTuiAgent
  const defaultCustomAgentId = settings.defaultCustomAgentId ?? null
  const agentOwnership = getSettingOwnershipSummary('agentLaunchDefaults')
  const cmdOverrides = settings.agentCmdOverrides ?? {}
  const agentDefaultArgs = settings.agentDefaultArgs ?? {}
  const agentDefaultEnv = settings.agentDefaultEnv ?? {}
  const agentPermissionMode = resolveAgentPermissionModeSummary({
    agentDefaultArgs,
    agentDefaultEnv
  })
  const disabledAgents = normalizeDisabledTuiAgents(settings.disabledTuiAgents)

  const setDefault = (id: TuiAgent | 'blank' | null): void => {
    // Why: setting a TuiAgent/blank default clears any custom default so the
    // two never compete; custom default takes priority when set.
    updateSettings({ defaultTuiAgent: id, defaultCustomAgentId: null })
  }

  const setDefaultCustomAgent = (id: string | null): void => {
    updateSettings({ defaultCustomAgentId: id })
  }

  const setAgentEnabled = (id: TuiAgent, enabled: boolean): void => {
    void enqueueAgentAvailabilityUpdate({
      getSettings: () => useAppStore.getState().settings,
      fallbackSettings: settings,
      updateSettings,
      agentId: id,
      enabled
    })
  }

  const saveOverride = (id: TuiAgent, value: string): void => {
    const next = { ...cmdOverrides }
    if (value) {
      next[id] = value
    } else {
      delete next[id]
    }
    updateSettings({ agentCmdOverrides: next })
  }

  const saveAgentArgs = (id: TuiAgent, value: string): void => {
    updateSettings({
      agentDefaultArgs: {
        ...agentDefaultArgs,
        [id]: value
      }
    })
  }

  const saveAgentEnv = (id: TuiAgent, value: Record<string, string>): void => {
    updateSettings({
      agentDefaultEnv: {
        ...agentDefaultEnv,
        [id]: value
      }
    })
  }

  const saveAgentPermissionMode = (mode: Exclude<AgentPermissionMode, 'mixed'>): void => {
    updateSettings(
      applyAgentPermissionMode({
        mode,
        agentDefaultArgs,
        agentDefaultEnv
      })
    )
  }

  const customAgents = settings.customAgents ?? []

  const saveCustomAgent = (agent: CustomAgent): void => {
    const existing = customAgents.findIndex((a) => a.id === agent.id)
    const next =
      existing >= 0
        ? customAgents.map((a) => (a.id === agent.id ? agent : a))
        : [...customAgents, agent]
    updateSettings({ customAgents: next })
  }

  const deleteCustomAgent = (id: string): void => {
    updateSettings({ customAgents: customAgents.filter((a) => a.id !== id) })
  }

  // Why: null means detection is in flight, not "all agents are installed".
  // Showing the full catalog here makes the default-agent picker flash invalid
  // options while switching between Windows and WSL detection contexts.
  const detectedAgents =
    detectedIds === null ? [] : getAgentCatalog().filter((agent) => detectedIds.has(agent.id))
  const enabledDetectedAgents = detectedAgents.filter((agent) =>
    isTuiAgentEnabled(agent.id, disabledAgents)
  )
  const undetectedAgents = getAgentCatalog().filter(
    (a) => detectedIds !== null && !detectedIds.has(a.id)
  )

  // Why: 'blank' is an explicit no-agent preference, not an auto fallback,
  // so the Auto pill should only light up when the default is null OR when a
  // selected agent id is no longer detected on PATH. A custom default overrides
  // TuiAgent selection, so Auto must not light up while a custom default is set.
  const isAutoDefault =
    defaultCustomAgentId === null &&
    (defaultAgent === null ||
      (defaultAgent !== 'blank' &&
        (!detectedIds?.has(defaultAgent) || !isTuiAgentEnabled(defaultAgent, disabledAgents))))
  const isBlankDefault = defaultCustomAgentId === null && defaultAgent === 'blank'

  return (
    <div className="space-y-8">
      <section className="space-y-4">
        <SettingsSubsectionHeader
          title={translate('auto.components.settings.AgentsPane.385212c7a1', 'Default Agent')}
          description={agentOwnership.description}
        />

        <div className="flex flex-wrap gap-2">
          <DefaultAgentPill active={isAutoDefault} onClick={() => setDefault(null)}>
            {isAutoDefault && <Check className="size-3.5" />}
            {translate('auto.components.settings.AgentsPane.92033495ff', 'Auto')}
          </DefaultAgentPill>

          {/* Why: users who prefer to open a raw shell by default need a
              first-class "no agent" choice here — without it, the Auto pill
              is the closest option but silently launches the first detected
              agent, which is the opposite of what they want. */}
          <DefaultAgentPill active={isBlankDefault} onClick={() => setDefault('blank')}>
            <Terminal className="size-3.5" />
            {translate(
              'auto.components.settings.AgentsPane.110b74b022',
              'No agent (blank terminal)'
            )}
            {isBlankDefault && <Check className="size-3.5" />}
          </DefaultAgentPill>

          {enabledDetectedAgents.map((agent) => {
            // Why: a custom default overrides TuiAgent selection, so a TuiAgent
            // pill is only active when no custom default is set.
            const isActive = defaultCustomAgentId === null && defaultAgent === agent.id
            return (
              <DefaultAgentPill
                key={agent.id}
                active={isActive}
                onClick={() => setDefault(agent.id)}
              >
                <AgentIcon agent={agent.id} size={14} />
                {agent.label}
                {isActive && <Check className="size-3.5" />}
              </DefaultAgentPill>
            )
          })}

          {customAgents.length > 0 && (
            <div className="flex w-full flex-wrap gap-2 pt-1">
              <span className="w-full text-[10px] font-medium uppercase tracking-wide text-muted-foreground/60">
                {translate(
                  'auto.components.settings.AgentsPane.customAgentsDefaultGroup',
                  'Custom agents'
                )}
              </span>
              {customAgents.map((agent) => {
                const isActive = defaultCustomAgentId === agent.id
                return (
                  <DefaultAgentPill
                    key={agent.id}
                    active={isActive}
                    onClick={() => setDefaultCustomAgent(isActive ? null : agent.id)}
                  >
                    <CustomAgentDefaultPillIcon agent={agent} />
                    {agent.label}
                    {isActive && <Check className="size-3.5" />}
                  </DefaultAgentPill>
                )
              })}
            </div>
          )}
        </div>
      </section>

      <AgentRuntimeSetting
        settings={settings}
        updateSettings={updateSettings}
        // Why: this control changes the client-local Windows/WSL runtime even
        // while the Installed list is scoped to an active remote server.
        refresh={refreshLocalAgents}
        wslSupportedPlatform={wslSupportedPlatform}
        wslAvailable={wslAvailable}
        wslDistros={wslDistros}
        wslCapabilitiesLoading={wslCapabilitiesLoading}
      />

      <AgentStatusHooksSetting settings={settings} updateSettings={updateSettings} />

      <AgentGeneratedTabTitlesSetting settings={settings} updateSettings={updateSettings} />

      <AgentAwakeSetting settings={settings} updateSettings={updateSettings} />

      <AgentCacheTimerSection settings={settings} updateSettings={updateSettings} />

      <AgentPermissionsSetting mode={agentPermissionMode} onChange={saveAgentPermissionMode} />

      <CustomAgentsSection
        customAgents={customAgents}
        onSave={saveCustomAgent}
        onDelete={deleteCustomAgent}
      />

      {detectedAgents.length > 0 && (
        <section className="space-y-3">
          <SettingsSubsectionHeader
            title={
              <span className="flex items-center gap-2">
                {translate('auto.components.settings.AgentsPane.02e0143be5', 'Installed')}
                <SettingsBadge tone="accent">
                  {detectedAgents.length}{' '}
                  {translate('auto.components.settings.AgentsPane.ed3e110e61', 'detected')}
                </SettingsBadge>
                {activeServerName ? (
                  <SettingsBadge tone="muted">
                    {translate('auto.components.settings.AgentsPane.03e1a5081a', 'on {{value0}}', {
                      value0: activeServerName
                    })}
                  </SettingsBadge>
                ) : null}
              </span>
            }
            action={
              <Button
                type="button"
                variant="ghost"
                size="xs"
                onClick={handleRefresh}
                disabled={isRefreshing}
                title={
                  activeServerEnvironmentId
                    ? translate(
                        'auto.components.settings.AgentsPane.25a41a9aad',
                        'Re-detect agents installed on the active server'
                      )
                    : translate(
                        'auto.components.settings.AgentsPane.13647f9f80',
                        'Re-read your shell PATH and re-detect installed agents'
                      )
                }
                className="h-7 gap-1.5 text-xs text-muted-foreground hover:text-foreground"
              >
                <RefreshCw className={cn('size-3', isRefreshing && 'animate-spin')} />
                {isRefreshing
                  ? translate('auto.components.settings.AgentsPane.c9b33eb5c0', 'Refreshing…')
                  : translate('auto.components.settings.AgentsPane.0d9e293a02', 'Refresh')}
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
                defaultArgs={getTuiAgentDefaultArgs(agent.id)}
                defaultEnv={getTuiAgentDefaultEnv(agent.id)}
                isDetected
                isEnabled={isTuiAgentEnabled(agent.id, disabledAgents)}
                isDefault={defaultAgent === agent.id}
                cmdOverride={cmdOverrides[agent.id]}
                argsOverride={resolveTuiAgentLaunchArgs(agent.id, agentDefaultArgs)}
                envOverride={resolveTuiAgentLaunchEnv(agent.id, agentDefaultEnv)}
                onSetDefault={() => setDefault(agent.id)}
                onSetEnabled={(enabled) => setAgentEnabled(agent.id, enabled)}
                onSaveOverride={(v) => saveOverride(agent.id, v)}
                onSaveArgs={(v) => saveAgentArgs(agent.id, v)}
                onSaveEnv={(v) => saveAgentEnv(agent.id, v)}
                sessionSourceHome={
                  agent.id === 'codex'
                    ? buildCodexSessionSourceHomeControl(settings, updateSettings)
                    : undefined
                }
              />
            ))}
          </div>
        </section>
      )}

      {undetectedAgents.length > 0 && (
        <section className="space-y-3">
          <SettingsSubsectionHeader
            title={
              <span className="flex items-center gap-2 text-muted-foreground">
                {translate(
                  'auto.components.settings.AgentsPane.e8da2af684',
                  'Available to install'
                )}
                <SettingsBadge tone="muted">
                  {undetectedAgents.length}{' '}
                  {translate('auto.components.settings.AgentsPane.024bd95089', 'agents')}
                </SettingsBadge>
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
                defaultArgs={getTuiAgentDefaultArgs(agent.id)}
                defaultEnv={getTuiAgentDefaultEnv(agent.id)}
                isDetected={false}
                isEnabled={isTuiAgentEnabled(agent.id, disabledAgents)}
                isDefault={false}
                cmdOverride={undefined}
                argsOverride={resolveTuiAgentLaunchArgs(agent.id, agentDefaultArgs)}
                envOverride={resolveTuiAgentLaunchEnv(agent.id, agentDefaultEnv)}
                onSetDefault={() => {}}
                onSetEnabled={(enabled) => setAgentEnabled(agent.id, enabled)}
                onSaveOverride={() => {}}
                onSaveArgs={(v) => saveAgentArgs(agent.id, v)}
                onSaveEnv={(v) => saveAgentEnv(agent.id, v)}
              />
            ))}
          </div>
        </section>
      )}

      {detectedIds === null && !detectionFailed && (
        <div className="flex items-center justify-center rounded-md border border-dashed border-border/50 py-6 text-sm text-muted-foreground">
          {translate(
            'auto.components.settings.AgentsPane.d83834f5e6',
            'Detecting installed agents…'
          )}
        </div>
      )}

      {detectionFailed && (
        <div className="flex items-start justify-between gap-3 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive">
          <span className="flex min-w-0 items-start gap-2">
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
            {translate(
              'auto.components.settings.AgentsPane.remoteDetectionFailed',
              'Couldn’t detect installed agents. Check the host connection and try again.'
            )}
          </span>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            onClick={handleRefresh}
            className="h-6 shrink-0 gap-1.5 px-2 text-destructive hover:text-destructive"
          >
            <RefreshCw className="size-3" />
            {translate('auto.components.settings.AgentsPane.retryDetection', 'Retry')}
          </Button>
        </div>
      )}
    </div>
  )
}

function createCustomAgentId(): string {
  return (
    globalThis.crypto?.randomUUID?.() ??
    `custom-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
  )
}

type CustomAgentEditorProps = {
  initial?: CustomAgent
  onSave: (agent: CustomAgent) => void
  onCancel: () => void
}

function CustomAgentEditor({
  initial,
  onSave,
  onCancel
}: CustomAgentEditorProps): React.JSX.Element {
  const [label, setLabel] = useState(initial?.label ?? '')
  const [cmd, setCmd] = useState(initial?.cmd ?? '')
  const [args, setArgs] = useState(initial?.args ?? '')
  const [iconUrl, setIconUrl] = useState(initial?.iconUrl ?? '')
  const [faviconDomain, setFaviconDomain] = useState(initial?.faviconDomain ?? '')
  const [envText, setEnvText] = useState(() => {
    if (!initial?.env) {
      return ''
    }
    return Object.entries(initial.env)
      .map(([k, v]) => `${k}=${v}`)
      .join('\n')
  })
  const [error, setError] = useState<string | null>(null)

  const handleSave = (): void => {
    const trimmedLabel = label.trim()
    const trimmedCmd = cmd.trim()
    if (!trimmedLabel) {
      setError(
        translate('auto.components.settings.AgentsPane.customAgentNameRequired', 'Name is required')
      )
      return
    }
    if (!trimmedCmd) {
      setError(
        translate(
          'auto.components.settings.AgentsPane.customAgentCmdRequired',
          'Command is required'
        )
      )
      return
    }

    const env: Record<string, string> = {}
    for (const line of envText.split('\n')) {
      const trimmedLine = line.trim()
      if (!trimmedLine) {
        continue
      }
      const eqIndex = trimmedLine.indexOf('=')
      if (eqIndex <= 0) {
        setError(
          translate(
            'auto.components.settings.AgentsPane.customAgentEnvFormat',
            'Environment must be KEY=VALUE per line'
          )
        )
        return
      }
      env[trimmedLine.slice(0, eqIndex).trim()] = trimmedLine.slice(eqIndex + 1).trim()
    }

    const trimmedIconUrl = iconUrl.trim()
    const trimmedFaviconDomain = faviconDomain.trim()

    onSave({
      id: initial?.id ?? createCustomAgentId(),
      label: trimmedLabel,
      cmd: trimmedCmd,
      ...(args.trim() ? { args: args.trim() } : {}),
      ...(Object.keys(env).length > 0 ? { env } : {}),
      ...(trimmedIconUrl ? { iconUrl: trimmedIconUrl } : {}),
      ...(trimmedFaviconDomain ? { faviconDomain: trimmedFaviconDomain } : {})
    })
  }

  return (
    <div className="space-y-3 rounded-md border border-border/60 bg-background/30 p-3">
      <div className="grid gap-2 sm:grid-cols-2">
        <div className="flex flex-col gap-1">
          <label className="text-xs text-muted-foreground">
            {translate('auto.components.settings.AgentsPane.customAgentName', 'Name')}
          </label>
          <Input
            value={label}
            onChange={(e) => {
              setLabel(e.target.value)
              if (error) {
                setError(null)
              }
            }}
            placeholder={translate(
              'auto.components.settings.AgentsPane.customAgentNamePlaceholder',
              'My Agent'
            )}
            className="h-7 text-xs"
            spellCheck={false}
          />
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-xs text-muted-foreground">
            {translate('auto.components.settings.AgentsPane.customAgentCmd', 'Command')}
          </label>
          <Input
            value={cmd}
            onChange={(e) => {
              setCmd(e.target.value)
              if (error) {
                setError(null)
              }
            }}
            placeholder={translate(
              'auto.components.settings.AgentsPane.customAgentCmdPlaceholder',
              'my-agent'
            )}
            className="h-7 font-mono text-xs"
            spellCheck={false}
          />
        </div>
      </div>
      <div className="flex flex-col gap-1">
        <label className="text-xs text-muted-foreground">
          {translate('auto.components.settings.AgentsPane.customAgentArgs', 'Arguments')}
        </label>
        <Input
          value={args}
          onChange={(e) => setArgs(e.target.value)}
          placeholder={translate(
            'auto.components.settings.AgentsPane.customAgentArgsPlaceholder',
            '--flag value'
          )}
          className="h-7 font-mono text-xs"
          spellCheck={false}
        />
      </div>
      <div className="flex flex-col gap-1">
        <label className="text-xs text-muted-foreground">
          {translate(
            'auto.components.settings.AgentsPane.customAgentEnv',
            'Environment (one KEY=VALUE per line)'
          )}
        </label>
        <textarea
          value={envText}
          onChange={(e) => setEnvText(e.target.value)}
          placeholder={translate(
            'auto.components.settings.AgentsPane.customAgentEnvPlaceholder',
            'API_KEY=xxx\nMODEL=gpt-4'
          )}
          rows={3}
          spellCheck={false}
          className="w-full resize-y rounded-md border border-input bg-transparent px-2 py-1 font-mono text-xs outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
        />
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        <div className="flex flex-col gap-1">
          <label className="text-xs text-muted-foreground">
            {translate('auto.components.settings.AgentsPane.customAgentIconUrl', 'Icon URL')}
          </label>
          <div className="flex gap-1.5">
            <Input
              value={iconUrl}
              onChange={(e) => setIconUrl(e.target.value)}
              placeholder={translate(
                'auto.components.settings.AgentsPane.customAgentIconUrlPlaceholder',
                'https://example.com/icon.png'
              )}
              className="h-7 flex-1 text-xs"
              spellCheck={false}
            />
            <Button
              type="button"
              variant="outline"
              size="xs"
              onClick={async () => {
                const result = await window.api.shell.pickAgentIconImage()
                if (result?.dataUrl) {
                  setIconUrl(result.dataUrl)
                }
              }}
              className="h-7 shrink-0 gap-1 text-xs"
            >
              <FolderOpen className="size-3" />
              {translate('auto.components.settings.AgentsPane.customAgentIconBrowse', 'Browse')}
            </Button>
          </div>
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-xs text-muted-foreground">
            {translate(
              'auto.components.settings.AgentsPane.customAgentFaviconDomain',
              'Favicon Domain'
            )}
          </label>
          <Input
            value={faviconDomain}
            onChange={(e) => setFaviconDomain(e.target.value)}
            placeholder={translate(
              'auto.components.settings.AgentsPane.customAgentFaviconDomainPlaceholder',
              'example.com'
            )}
            className="h-7 font-mono text-xs"
            spellCheck={false}
          />
        </div>
      </div>
      {error && <p className="text-[11px] text-destructive">{error}</p>}
      <div className="flex items-center justify-end gap-2">
        <Button type="button" variant="ghost" size="xs" onClick={onCancel} className="h-7 text-xs">
          {translate('auto.components.settings.AgentsPane.customAgentCancel', 'Cancel')}
        </Button>
        <Button
          type="button"
          variant="default"
          size="xs"
          onClick={handleSave}
          className="h-7 text-xs"
        >
          {translate('auto.components.settings.AgentsPane.customAgentSave', 'Save')}
        </Button>
      </div>
    </div>
  )
}

type CustomAgentsSectionProps = {
  customAgents: CustomAgent[]
  onSave: (agent: CustomAgent) => void
  onDelete: (id: string) => void
}

function CustomAgentsSection({
  customAgents,
  onSave,
  onDelete
}: CustomAgentsSectionProps): React.JSX.Element {
  const [isAdding, setIsAdding] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)

  return (
    <section className="space-y-3">
      <SettingsSubsectionHeader
        title={translate('auto.components.settings.AgentsPane.customAgentsTitle', 'Custom Agents')}
        description={translate(
          'auto.components.settings.AgentsPane.customAgentsDescription',
          'Add your own CLI agents that are not in the built-in catalog.'
        )}
        action={
          !isAdding ? (
            <Button
              type="button"
              variant="ghost"
              size="xs"
              onClick={() => {
                setIsAdding(true)
                setEditingId(null)
              }}
              className="h-7 gap-1.5 text-xs text-muted-foreground hover:text-foreground"
            >
              <Plus className="size-3" />
              {translate('auto.components.settings.AgentsPane.customAgentAdd', 'Add')}
            </Button>
          ) : null
        }
      />

      {isAdding && (
        <CustomAgentEditor
          onSave={(agent) => {
            onSave(agent)
            setIsAdding(false)
          }}
          onCancel={() => setIsAdding(false)}
        />
      )}

      {customAgents.length > 0 && (
        <div className="divide-y divide-border/40">
          {customAgents.map((agent) => {
            const isEditing = editingId === agent.id
            if (isEditing) {
              return (
                <CustomAgentEditor
                  key={agent.id}
                  initial={agent}
                  onSave={(updated) => {
                    onSave(updated)
                    setEditingId(null)
                  }}
                  onCancel={() => setEditingId(null)}
                />
              )
            }
            const envSummary = agent.env
              ? Object.entries(agent.env)
                  .map(([k, v]) => `${k}=${v}`)
                  .join(' ')
              : ''
            return (
              <div key={agent.id} className="flex flex-wrap items-start gap-3 py-3">
                <div className="flex size-7 shrink-0 items-center justify-center rounded-md border border-border/50 bg-background/50">
                  {agent.iconUrl ? (
                    <img
                      src={agent.iconUrl}
                      width={16}
                      height={16}
                      alt=""
                      aria-hidden
                      style={{ borderRadius: 2 }}
                    />
                  ) : agent.faviconDomain ? (
                    <img
                      src={`https://www.google.com/s2/favicons?domain=${agent.faviconDomain}&sz=64`}
                      width={16}
                      height={16}
                      alt=""
                      aria-hidden
                      style={{ borderRadius: 2 }}
                    />
                  ) : (
                    <span className="text-xs font-medium text-muted-foreground">
                      {agent.label.charAt(0).toUpperCase()}
                    </span>
                  )}
                </div>
                <div className="min-w-0 flex-1 sm:min-w-[12rem]">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium leading-none">{agent.label}</span>
                    <SettingsBadge tone="muted">
                      {translate('auto.components.settings.AgentsPane.customAgentBadge', 'Custom')}
                    </SettingsBadge>
                  </div>
                  <div className="mt-1 truncate font-mono text-[11px] text-muted-foreground">
                    {agent.cmd}
                    {agent.args && <span className="ml-1.5 text-foreground/70">{agent.args}</span>}
                    {envSummary && <span className="ml-1.5 text-foreground/60">{envSummary}</span>}
                  </div>
                </div>
                <div className="ml-auto flex shrink-0 items-center gap-1">
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    onClick={() => {
                      setEditingId(agent.id)
                      setIsAdding(false)
                    }}
                    aria-label={translate(
                      'auto.components.settings.AgentsPane.customAgentEdit',
                      'Edit custom agent'
                    )}
                    className="size-7 text-muted-foreground hover:text-foreground"
                  >
                    <Pencil className="size-3.5" />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    onClick={() => onDelete(agent.id)}
                    aria-label={translate(
                      'auto.components.settings.AgentsPane.customAgentDelete',
                      'Delete custom agent'
                    )}
                    className="size-7 text-muted-foreground hover:text-destructive"
                  >
                    <Trash2 className="size-3.5" />
                  </Button>
                </div>
              </div>
            )
          })}
        </div>
      )}

      {customAgents.length === 0 && !isAdding && (
        <div className="flex items-center justify-center rounded-md border border-dashed border-border/50 py-6 text-sm text-muted-foreground">
          {translate(
            'auto.components.settings.AgentsPane.customAgentsEmpty',
            'No custom agents. Click "Add" to create one.'
          )}
        </div>
      )}
    </section>
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
        label={getAgentStatusHooksTitle()}
        description={getAgentStatusHooksDescription()}
        checked={enabled}
        onChange={() =>
          updateSettings({
            agentStatusHooksEnabled: !enabled
          })
        }
        ariaLabel={getAgentStatusHooksTitle()}
      />
    </section>
  )
}

export function AgentGeneratedTabTitlesSetting({
  settings,
  updateSettings
}: AgentsPaneProps): React.JSX.Element {
  const enabled = settings.tabAutoGenerateTitle === true
  return (
    <section className="space-y-3">
      <SettingsSwitchRow
        label={getAgentGeneratedTabTitlesTitle()}
        description={getAgentGeneratedTabTitlesDescription()}
        checked={enabled}
        onChange={() =>
          updateSettings({
            tabAutoGenerateTitle: !enabled
          })
        }
        ariaLabel={getAgentGeneratedTabTitlesTitle()}
      />
    </section>
  )
}
