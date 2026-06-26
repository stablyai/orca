/* eslint-disable max-lines -- Why: the Agents pane keeps catalog rows, default
   selection, per-agent controls, and runtime location together so settings
   reconciliation stays visible in one file. */
import { useId, useMemo, useState } from 'react'
import {
  Braces,
  Check,
  ChevronDown,
  Copy,
  ExternalLink,
  Info,
  RefreshCw,
  Terminal,
  Trash2
} from 'lucide-react'
import type { GlobalSettings, TuiAgent, TuiAgentProfile } from '../../../../shared/types'
import { getAgentCatalog, getAgentCatalogWithProfiles, AgentIcon } from '@/lib/agent-catalog'
import { useDetectedAgents } from '@/hooks/useDetectedAgents'
import { useAppStore } from '@/store'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { cn } from '@/lib/utils'
import { AgentAwakeSetting } from './AgentAwakeSetting'
import { AgentCacheTimerSection } from './AgentCacheTimerSection'
import { AgentRuntimeSetting } from './AgentRuntimeSetting'
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
import { isBuiltInTuiAgent } from '../../../../shared/tui-agent-config'
import {
  getTuiAgentDefaultArgs,
  getTuiAgentDefaultEnv
} from '../../../../shared/tui-agent-launch-defaults'
import {
  createTuiAgentProfileId,
  normalizeTuiAgentProfiles
} from '../../../../shared/tui-agent-profiles'
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
  iconAgent: TuiAgent
  label: string
  homepageUrl: string
  defaultCmd: string
  defaultArgs: string
  defaultEnv: Record<string, string>
  isProfile?: boolean
  isDetected: boolean
  isEnabled: boolean
  isDefault: boolean
  cmdOverride: string | undefined
  argsOverride: string
  envOverride: Record<string, string>
  onSetDefault: () => void
  onSetEnabled: (enabled: boolean) => void
  onDuplicate?: () => void
  onDelete?: () => void
  onSaveLabel?: (value: string) => void
  onSaveOverride: (value: string) => void
  onSaveArgs: (value: string) => void
  onSaveEnv: (value: Record<string, string>) => void
}

type AgentProfileNameInputProps = {
  label: string
  onSaveLabel: (value: string) => void
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

const WORKTREE_PATH_VARIABLE_TOKEN = '{worktreePath}'
const REPO_PATH_VARIABLE_TOKEN = '{repoPath}'

function AgentLaunchVariableHint(): React.JSX.Element {
  return (
    <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
      <span className="inline-flex items-center gap-1">
        <Braces className="size-3" />
        {translate('auto.components.settings.AgentsPane.variables', 'Variables')}
      </span>
      <span className="rounded px-1.5 py-0.5 font-mono text-[10px] text-foreground/80">
        {REPO_PATH_VARIABLE_TOKEN}
      </span>
      <span className="rounded px-1.5 py-0.5 font-mono text-[10px] text-foreground/80">
        {WORKTREE_PATH_VARIABLE_TOKEN}
      </span>
      <span>
        {translate(
          'auto.components.settings.AgentsPane.worktreePathVariableHint',
          'Available in command, arguments, and environment values.'
        )}
      </span>
    </div>
  )
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
    <div className="flex items-center gap-2">
      <span className="shrink-0 text-xs text-muted-foreground">
        {translate('auto.components.settings.AgentsPane.2e45ca29b6', 'Command')}
      </span>
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
  )
}

function AgentProfileNameInput({
  label,
  onSaveLabel
}: AgentProfileNameInputProps): React.JSX.Element {
  const [draft, setDraft] = useState(label)

  const commitLabel = (): void => {
    const trimmed = draft.trim().replace(/\s+/g, ' ')
    if (trimmed) {
      onSaveLabel(trimmed)
      setDraft(trimmed)
    } else {
      setDraft(label)
    }
  }

  return (
    <div className="flex items-center gap-2">
      <span className="shrink-0 text-xs text-muted-foreground">
        {translate('auto.components.settings.AgentsPane.profileName', 'Name')}
      </span>
      <Input
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commitLabel}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            commitLabel()
            e.currentTarget.blur()
          }
          if (e.key === 'Escape') {
            setDraft(label)
            e.currentTarget.blur()
          }
        }}
        spellCheck={false}
        className="h-7 flex-1 text-xs"
      />
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
    <div className="flex items-center gap-2">
      <span className="shrink-0 text-xs text-muted-foreground">
        {translate('auto.components.settings.AgentsPane.cfb3f35775', 'Arguments')}
      </span>
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
    <div>
      <div className="flex items-center gap-2">
        <span className="shrink-0 text-xs text-muted-foreground">
          {translate('auto.components.settings.AgentsPane.8fbe1f37c1', 'Environment')}
        </span>
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
  iconAgent,
  label,
  homepageUrl,
  defaultCmd,
  defaultArgs,
  defaultEnv,
  isProfile = false,
  isDetected,
  isEnabled,
  isDefault,
  cmdOverride,
  argsOverride,
  envOverride,
  onSetDefault,
  onSetEnabled,
  onDuplicate,
  onDelete,
  onSaveLabel,
  onSaveOverride,
  onSaveArgs,
  onSaveEnv
}: AgentRowProps): React.JSX.Element {
  const envSummary = stringifyAgentDefaultEnvDraft(envOverride)
  const defaultEnvSummary = stringifyAgentDefaultEnvDraft(defaultEnv)
  const [cmdOpen, setCmdOpen] = useState(
    isProfile ||
      Boolean(cmdOverride) ||
      argsOverride !== defaultArgs ||
      envSummary !== defaultEnvSummary
  )

  return (
    <div className={cn('py-3', !isDetected && 'opacity-70')}>
      <div className="flex flex-wrap items-start gap-3">
        <div className="flex size-7 shrink-0 items-center justify-center rounded-md border border-border/50 bg-background/50">
          <AgentIcon agent={iconAgent} size={16} />
        </div>

        <div className="min-w-0 flex-1 sm:min-w-[12rem]">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium leading-none">{label}</span>
            {isProfile && (
              <SettingsBadge tone="muted">
                {translate('auto.components.settings.AgentsPane.profileBadge', 'Profile')}
              </SettingsBadge>
            )}
            {isDetected ? (
              <SettingsBadge tone="accent">
                {translate('auto.components.settings.AgentsPane.c8794e622e', 'Detected')}
              </SettingsBadge>
            ) : (
              <SettingsBadge tone="muted">
                {translate('auto.components.settings.AgentsPane.df123171d1', 'Not installed')}
              </SettingsBadge>
            )}
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

        <div className="ml-auto grid shrink-0 grid-cols-[max-content_6.5rem_1.75rem_1.75rem_1.75rem_1.75rem] items-center gap-1.5">
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

          <div className="flex size-7 items-center justify-center">
            {isDetected && (
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                onClick={() => setCmdOpen((prev) => !prev)}
                title={translate(
                  'auto.components.settings.AgentsPane.db9e9e5887',
                  'Customize command'
                )}
                aria-expanded={cmdOpen}
                className={cn(
                  'size-7 text-muted-foreground hover:text-foreground',
                  (cmdOpen || cmdOverride) && 'text-foreground'
                )}
              >
                <Terminal className="size-3.5" />
              </Button>
            )}
          </div>

          <div className="flex size-7 items-center justify-center">
            {isDetected && onDuplicate && (
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                onClick={onDuplicate}
                title={translate(
                  'auto.components.settings.AgentsPane.duplicateProfile',
                  'Duplicate agent'
                )}
                className="size-7 text-muted-foreground hover:text-foreground"
              >
                <Copy className="size-3.5" />
              </Button>
            )}
            {isDetected && onDelete && (
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                onClick={onDelete}
                title={translate(
                  'auto.components.settings.AgentsPane.deleteProfile',
                  'Delete profile'
                )}
                className="size-7 text-muted-foreground hover:text-destructive"
              >
                <Trash2 className="size-3.5" />
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
          {onSaveLabel && (
            <div className="mb-2">
              <AgentProfileNameInput
                key={`${agentId}:${label}`}
                label={label}
                onSaveLabel={onSaveLabel}
              />
            </div>
          )}
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
          <AgentLaunchVariableHint />
          <p className="mt-1.5 text-[11px] text-muted-foreground">
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

function makeUniqueProfileLabel(label: string, existingLabels: Iterable<string>): string {
  const normalizedExisting = new Set([...existingLabels].map((entry) => entry.toLocaleLowerCase()))
  const normalizedLabel = label.toLocaleLowerCase()
  if (!normalizedExisting.has(normalizedLabel)) {
    return label
  }
  for (let index = 2; index < 1000; index += 1) {
    const candidate = `${label} ${index}`
    if (!normalizedExisting.has(candidate.toLocaleLowerCase())) {
      return candidate
    }
  }
  return `${label} ${Date.now().toString(36)}`
}

function updateAgentProfile(
  profiles: readonly TuiAgentProfile[],
  id: TuiAgent,
  updates: Partial<TuiAgentProfile>
): TuiAgentProfile[] {
  return normalizeTuiAgentProfiles(
    profiles.map((profile) => (profile.id === id ? { ...profile, ...updates } : profile))
  )
}

function getRawAgentArgsOverride(
  agent: TuiAgent,
  configuredArgs: Partial<Record<TuiAgent, string>>,
  defaultArgs: string
): string {
  return typeof configuredArgs[agent] === 'string' ? (configuredArgs[agent] ?? '') : defaultArgs
}

function getRawAgentEnvOverride(
  agent: TuiAgent,
  configuredEnv: Partial<Record<TuiAgent, Record<string, string>>>,
  defaultEnv: Record<string, string>
): Record<string, string> {
  return configuredEnv[agent] ?? defaultEnv
}

export function AgentsPane({
  settings,
  updateSettings,
  wslSupportedPlatform,
  wslAvailable,
  wslDistros,
  wslCapabilitiesLoading
}: AgentsPaneProps): React.JSX.Element {
  const { detectedIds: detectedList, isRefreshing, refresh } = useDetectedAgents()
  // Why: refresh re-spawns the user's login shell to re-capture PATH
  // (preflight:refreshAgents on the main side). This handles the
  // "installed a new CLI, Orca doesn't see it yet" case without a restart.
  const handleRefresh = (): void => {
    void refresh()
  }
  const detectedIds = useMemo<Set<TuiAgent> | null>(
    () => (detectedList ? new Set(detectedList) : null),
    [detectedList]
  )

  const defaultAgent = settings.defaultTuiAgent
  const agentOwnership = getSettingOwnershipSummary('agentLaunchDefaults')
  const cmdOverrides = settings.agentCmdOverrides ?? {}
  const agentDefaultArgs = settings.agentDefaultArgs ?? {}
  const agentDefaultEnv = settings.agentDefaultEnv ?? {}
  const agentProfiles = normalizeTuiAgentProfiles(settings.agentProfiles)
  const profileById: ReadonlyMap<TuiAgent, TuiAgentProfile> = new Map(
    agentProfiles.map((profile) => [profile.id, profile])
  )
  const baseCatalog = getAgentCatalog()
  const baseCatalogById = new Map(baseCatalog.map((entry) => [entry.id, entry]))
  const agentPermissionMode = resolveAgentPermissionModeSummary({
    agentDefaultArgs,
    agentDefaultEnv
  })
  const disabledAgents = normalizeDisabledTuiAgents(settings.disabledTuiAgents)

  const setDefault = (id: TuiAgent | 'blank' | null): void => {
    updateSettings({ defaultTuiAgent: id })
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

  const saveAgentProfiles = (profiles: TuiAgentProfile[]): void => {
    updateSettings({ agentProfiles: normalizeTuiAgentProfiles(profiles) })
  }

  const duplicateAgent = (id: TuiAgent): void => {
    const entry = baseCatalogById.get(id)
    if (!entry || !isBuiltInTuiAgent(entry.id)) {
      return
    }
    const labels = [
      ...baseCatalog.map((agent) => agent.label),
      ...agentProfiles.map((profile) => profile.label)
    ]
    const label = makeUniqueProfileLabel(`${entry.label} (custom)`, labels)
    saveAgentProfiles([
      ...agentProfiles,
      {
        id: createTuiAgentProfileId(entry.id),
        baseAgent: entry.id,
        label,
        ...(cmdOverrides[id] ? { cmdOverride: cmdOverrides[id] } : {}),
        defaultArgs: getRawAgentArgsOverride(id, agentDefaultArgs, getTuiAgentDefaultArgs(id)),
        defaultEnv: getRawAgentEnvOverride(id, agentDefaultEnv, getTuiAgentDefaultEnv(id))
      }
    ])
  }

  const deleteAgentProfile = (id: TuiAgent): void => {
    const nextProfiles = agentProfiles.filter((profile) => profile.id !== id)
    updateSettings({
      agentProfiles: nextProfiles,
      ...(defaultAgent === id ? { defaultTuiAgent: null } : {})
    })
  }

  const saveAgentProfileLabel = (id: TuiAgent, value: string): void => {
    const labels = [
      ...baseCatalog.map((agent) => agent.label),
      ...agentProfiles.filter((profile) => profile.id !== id).map((profile) => profile.label)
    ]
    saveAgentProfiles(
      updateAgentProfile(agentProfiles, id, {
        label: makeUniqueProfileLabel(value, labels)
      })
    )
  }

  const saveAgentProfileCommand = (id: TuiAgent, value: string): void => {
    saveAgentProfiles(
      updateAgentProfile(agentProfiles, id, {
        cmdOverride: value || undefined
      })
    )
  }

  const saveAgentProfileArgs = (id: TuiAgent, value: string): void => {
    saveAgentProfiles(updateAgentProfile(agentProfiles, id, { defaultArgs: value }))
  }

  const saveAgentProfileEnv = (id: TuiAgent, value: Record<string, string>): void => {
    saveAgentProfiles(updateAgentProfile(agentProfiles, id, { defaultEnv: value }))
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

  // Why: null means detection is in flight, not "all agents are installed".
  // Showing the full catalog here makes the default-agent picker flash invalid
  // options while switching between Windows and WSL detection contexts.
  const catalogWithProfiles = getAgentCatalogWithProfiles(agentProfiles)
  const detectedAgentEntries = catalogWithProfiles.filter((agent) => {
    return detectedIds !== null && detectedIds.has(agent.baseAgent ?? agent.id)
  })
  const enabledDetectedAgentEntries = detectedAgentEntries.filter((agent) =>
    isTuiAgentEnabled(agent.id, disabledAgents)
  )
  const undetectedAgents = baseCatalog.filter((a) => detectedIds !== null && !detectedIds.has(a.id))

  // Why: 'blank' is an explicit no-agent preference, not an auto fallback,
  // so the Auto pill should only light up when the default is null OR when a
  // selected agent id is no longer detected on PATH.
  const defaultAgentIsDetectedProfile = detectedAgentEntries.some(
    (agent) => agent.id === defaultAgent
  )
  const isAutoDefault =
    defaultAgent === null ||
    (defaultAgent !== 'blank' &&
      ((!detectedIds?.has(defaultAgent) && !defaultAgentIsDetectedProfile) ||
        !isTuiAgentEnabled(defaultAgent, disabledAgents)))
  const isBlankDefault = defaultAgent === 'blank'

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

          {enabledDetectedAgentEntries.map((agent) => {
            const isActive = defaultAgent === agent.id
            return (
              <DefaultAgentPill
                key={agent.id}
                active={isActive}
                onClick={() => setDefault(agent.id)}
              >
                <AgentIcon agent={agent.baseAgent ?? agent.id} size={14} />
                {agent.label}
                {isActive && <Check className="size-3.5" />}
              </DefaultAgentPill>
            )
          })}
        </div>
      </section>

      <AgentRuntimeSetting
        settings={settings}
        updateSettings={updateSettings}
        refresh={refresh}
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

      {detectedAgentEntries.length > 0 && (
        <section className="space-y-3">
          <SettingsSubsectionHeader
            title={
              <span className="flex items-center gap-2">
                {translate('auto.components.settings.AgentsPane.02e0143be5', 'Installed')}
                <SettingsBadge tone="accent">
                  {detectedAgentEntries.length}{' '}
                  {translate('auto.components.settings.AgentsPane.ed3e110e61', 'detected')}
                </SettingsBadge>
              </span>
            }
            action={
              <Button
                type="button"
                variant="ghost"
                size="xs"
                onClick={handleRefresh}
                disabled={isRefreshing}
                title={translate(
                  'auto.components.settings.AgentsPane.13647f9f80',
                  'Re-read your shell PATH and re-detect installed agents'
                )}
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
            {detectedAgentEntries.map((agent) => {
              const profile = profileById.get(agent.id)
              if (!profile) {
                const defaultArgs = getTuiAgentDefaultArgs(agent.id)
                const defaultEnv = getTuiAgentDefaultEnv(agent.id)
                return (
                  <AgentRow
                    key={agent.id}
                    agentId={agent.id}
                    iconAgent={agent.id}
                    label={agent.label}
                    homepageUrl={agent.homepageUrl}
                    defaultCmd={agent.cmd}
                    defaultArgs={defaultArgs}
                    defaultEnv={defaultEnv}
                    isDetected
                    isEnabled={isTuiAgentEnabled(agent.id, disabledAgents)}
                    isDefault={defaultAgent === agent.id}
                    cmdOverride={cmdOverrides[agent.id]}
                    argsOverride={getRawAgentArgsOverride(agent.id, agentDefaultArgs, defaultArgs)}
                    envOverride={getRawAgentEnvOverride(agent.id, agentDefaultEnv, defaultEnv)}
                    onSetDefault={() => setDefault(agent.id)}
                    onSetEnabled={(enabled) => setAgentEnabled(agent.id, enabled)}
                    onDuplicate={() => duplicateAgent(agent.id)}
                    onSaveOverride={(v) => saveOverride(agent.id, v)}
                    onSaveArgs={(v) => saveAgentArgs(agent.id, v)}
                    onSaveEnv={(v) => saveAgentEnv(agent.id, v)}
                  />
                )
              }
              const baseEntry = baseCatalogById.get(profile.baseAgent)
              const defaultArgs = getTuiAgentDefaultArgs(profile.baseAgent)
              const defaultEnv = getTuiAgentDefaultEnv(profile.baseAgent)
              return (
                <AgentRow
                  key={agent.id}
                  agentId={agent.id}
                  iconAgent={profile.baseAgent}
                  label={agent.label}
                  homepageUrl={agent.homepageUrl}
                  defaultCmd={baseEntry?.cmd ?? profile.baseAgent}
                  defaultArgs={defaultArgs}
                  defaultEnv={defaultEnv}
                  isProfile
                  isDetected
                  isEnabled={isTuiAgentEnabled(agent.id, disabledAgents)}
                  isDefault={defaultAgent === agent.id}
                  cmdOverride={profile.cmdOverride}
                  argsOverride={profile.defaultArgs ?? defaultArgs}
                  envOverride={profile.defaultEnv ?? defaultEnv}
                  onSetDefault={() => setDefault(agent.id)}
                  onSetEnabled={(enabled) => setAgentEnabled(agent.id, enabled)}
                  onDelete={() => deleteAgentProfile(agent.id)}
                  onSaveLabel={(v) => saveAgentProfileLabel(agent.id, v)}
                  onSaveOverride={(v) => saveAgentProfileCommand(agent.id, v)}
                  onSaveArgs={(v) => saveAgentProfileArgs(agent.id, v)}
                  onSaveEnv={(v) => saveAgentProfileEnv(agent.id, v)}
                />
              )
            })}
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
            {undetectedAgents.map((agent) => {
              const defaultArgs = getTuiAgentDefaultArgs(agent.id)
              const defaultEnv = getTuiAgentDefaultEnv(agent.id)
              return (
                <AgentRow
                  key={agent.id}
                  agentId={agent.id}
                  iconAgent={agent.id}
                  label={agent.label}
                  homepageUrl={agent.homepageUrl}
                  defaultCmd={agent.cmd}
                  defaultArgs={defaultArgs}
                  defaultEnv={defaultEnv}
                  isDetected={false}
                  isEnabled={isTuiAgentEnabled(agent.id, disabledAgents)}
                  isDefault={false}
                  cmdOverride={undefined}
                  argsOverride={getRawAgentArgsOverride(agent.id, agentDefaultArgs, defaultArgs)}
                  envOverride={getRawAgentEnvOverride(agent.id, agentDefaultEnv, defaultEnv)}
                  onSetDefault={() => {}}
                  onSetEnabled={(enabled) => setAgentEnabled(agent.id, enabled)}
                  onSaveOverride={() => {}}
                  onSaveArgs={(v) => saveAgentArgs(agent.id, v)}
                  onSaveEnv={(v) => saveAgentEnv(agent.id, v)}
                />
              )
            })}
          </div>
        </section>
      )}

      {detectedIds === null && (
        <div className="flex items-center justify-center rounded-md border border-dashed border-border/50 py-6 text-sm text-muted-foreground">
          {translate(
            'auto.components.settings.AgentsPane.d83834f5e6',
            'Detecting installed agents…'
          )}
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
