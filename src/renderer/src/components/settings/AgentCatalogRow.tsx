import { useEffect, useRef, useState } from 'react'
import { Check, ChevronDown, ExternalLink } from 'lucide-react'
import type { TuiAgent } from '../../../../shared/tui-agent'
import { AgentIcon } from '@/lib/agent-catalog'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import { Button } from '../ui/button'
import { SettingsBadge, SettingsSegmentedControl } from './SettingsFormControls'
import type { AgentSessionSourceHomeControl } from './codex-session-source-home-control'
import { AgentSessionSourceHomeInput } from './codex-session-source-home-control'
import { stringifyAgentDefaultEnvDraft } from './agent-default-env-draft'
import {
  AgentCommandOverrideInput,
  AgentDefaultArgsInput,
  AgentDefaultEnvInput
} from './AgentLaunchDefaultsEditor'
import { AgentPermissionOverrideControl } from './AgentPermissionControls'
import type { AgentPermissionMode } from '../../../../shared/tui-agent-permissions'
import type { AgentPermissionRevealTarget } from './agent-permission-exceptions'

/** The control a reveal focuses: the Permissions choice, or the field whose text decides. */
const REVEAL_FOCUS_SELECTOR: Record<AgentPermissionRevealTarget, string> = {
  permissions: '[role="radio"][aria-checked="true"]',
  arguments: 'input',
  environment: 'input'
}

type AgentAvailability = 'enabled' | 'disabled'

export function AgentAvailabilityControl({
  label,
  isEnabled,
  onSetEnabled
}: {
  label: string
  isEnabled: boolean
  onSetEnabled: (enabled: boolean) => void
}): React.JSX.Element {
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

export type AgentCatalogRowProps = {
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
  sessionSourceHome?: AgentSessionSourceHomeControl
  /** Shows the environment editor even when empty (agents whose permission mode is an env var). */
  envEditable?: boolean
  /** Absent for agents with no permission flag to set. */
  permission?: {
    override: AgentPermissionMode | undefined
    defaultMode: AgentPermissionMode
    /** The field that decides the launch instead of this choice, when Arguments or env set it. */
    decidedBy: 'arguments' | 'environment' | null
    onChange: (choice: AgentPermissionMode | 'default') => void
  }
  /** A request from the Agent Permissions line to open this row and focus one of its controls. */
  reveal?: { target: AgentPermissionRevealTarget; nonce: number }
}

export function AgentCatalogRow({
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
  sessionSourceHome,
  envEditable,
  permission,
  reveal
}: AgentCatalogRowProps): React.JSX.Element {
  const envSummary = stringifyAgentDefaultEnvDraft(envOverride)
  const defaultEnvSummary = stringifyAgentDefaultEnvDraft(defaultEnv)
  const permissionControl = permission ? (
    <AgentPermissionOverrideControl
      agentLabel={label}
      override={permission.override}
      defaultMode={permission.defaultMode}
      onChange={permission.onChange}
    />
  ) : null
  const argumentsField = (
    <div data-agent-reveal="arguments">
      <AgentDefaultArgsInput
        key={`${agentId}:${argsOverride}`}
        defaultArgs={defaultArgs}
        argsOverride={argsOverride}
        onSaveArgs={onSaveArgs}
      />
    </div>
  )
  const environmentField = (
    <div data-agent-reveal="environment">
      <AgentDefaultEnvInput
        key={`${agentId}:${envSummary}`}
        defaultEnv={defaultEnv}
        envOverride={envOverride}
        onSaveEnv={onSaveEnv}
      />
    </div>
  )
  const [cmdOpen, setCmdOpen] = useState(
    Boolean(cmdOverride) ||
      argsOverride !== defaultArgs ||
      envSummary !== defaultEnvSummary ||
      permission?.override !== undefined
  )
  // A new reveal opens the row in the same render, so its controls exist when the effect focuses.
  const [openedForReveal, setOpenedForReveal] = useState(reveal?.nonce)
  if (reveal && reveal.nonce !== openedForReveal) {
    setOpenedForReveal(reveal.nonce)
    setCmdOpen(true)
  }
  const rowRef = useRef<HTMLDivElement>(null)
  const focusedReveal = useRef(reveal?.nonce)
  useEffect(() => {
    if (!reveal || reveal.nonce === focusedReveal.current) {
      return
    }
    focusedReveal.current = reveal.nonce
    const control = rowRef.current?.querySelector<HTMLElement>(
      `[data-agent-reveal="${reveal.target}"] ${REVEAL_FOCUS_SELECTOR[reveal.target]}`
    )
    control?.scrollIntoView?.({ block: 'center' })
    // focusVisible: after a mouse click on the link, a radio's ring would otherwise stay hidden.
    control?.focus({ preventScroll: true, focusVisible: true })
  }, [reveal])

  return (
    <div ref={rowRef} data-agent-row={agentId} className={cn('py-3', !isDetected && 'opacity-70')}>
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
                onClick={() => setCmdOpen((previous) => !previous)}
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

      {/* An undetected agent's own choice still applies where it runs (an SSH host), so it stays clearable. */}
      {!isDetected && permission?.override !== undefined && (
        <div className="mt-3 pl-10">
          {/* When Arguments or env decide, show that field too, so its link lands where it says. */}
          {permission.decidedBy === 'arguments' && <div className="mb-2">{argumentsField}</div>}
          {permission.decidedBy === 'environment' && <div className="mb-2">{environmentField}</div>}
          <div data-agent-reveal="permissions">{permissionControl}</div>
        </div>
      )}

      {isDetected && cmdOpen && (
        <div className="mt-3 pl-10">
          <AgentCommandOverrideInput
            key={cmdOverride ?? defaultCmd}
            defaultCmd={defaultCmd}
            cmdOverride={cmdOverride}
            onSaveOverride={onSaveOverride}
          />
          <div className="mt-2">{argumentsField}</div>
          {permissionControl && (
            <div className="mt-2" data-agent-reveal="permissions">
              {permissionControl}
            </div>
          )}
          {(envEditable || defaultEnvSummary || envSummary) && (
            <div className="mt-2">{environmentField}</div>
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
