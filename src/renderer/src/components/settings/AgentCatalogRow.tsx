import { useRef, useState } from 'react'
import { Check, ChevronDown, ExternalLink } from 'lucide-react'
import type { TuiAgent } from '../../../../shared/tui-agent'
import { AgentIcon } from '@/lib/agent-catalog'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import { Button } from '../ui/button'
import { SettingsBadge, SettingsSegmentedControl } from './SettingsFormControls'
import type { AgentSessionSourceHomeControl } from './codex-session-source-home-control'
import { AgentSessionSourceHomeInput } from './codex-session-source-home-control'
import { resolveTuiAgentPermissionMode } from '../../../../shared/tui-agent-permissions'
import { stringifyAgentDefaultEnvDraft } from './agent-default-env-draft'
import {
  AgentPermissionExceptionBadge,
  AgentRowPermissionControl,
  type AgentRowPermission
} from './AgentRowPermissions'
import {
  AgentCommandOverrideInput,
  AgentDefaultArgsInput,
  AgentDefaultEnvInput
} from './AgentLaunchDefaultsEditor'

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
  onSaveOverride: (value: string) => void | Promise<void>
  onSaveArgs: (value: string) => void | Promise<void>
  onSaveEnv: (value: Record<string, string>) => void
  sessionSourceHome?: AgentSessionSourceHomeControl
  environmentNames?: readonly string[]
  /** Absent for agents without a configurable permission mode on this host. */
  permission?: AgentRowPermission
  environmentEditor?: React.ReactNode
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
  environmentNames,
  environmentEditor,
  permission
}: AgentCatalogRowProps): React.JSX.Element {
  const envSummary = environmentNames?.join(' ') ?? stringifyAgentDefaultEnvDraft(envOverride)
  const defaultEnvSummary = stringifyAgentDefaultEnvDraft(defaultEnv)
  const [cmdOpen, setCmdOpen] = useState(
    Boolean(cmdOverride) ||
      (argsOverride !== defaultArgs &&
        resolveTuiAgentPermissionMode({
          agent: agentId,
          agentArgs: argsOverride,
          agentEnv: envOverride
        }) === 'mixed') ||
      envSummary !== defaultEnvSummary
  )
  const permissionRef = useRef<HTMLDivElement>(null)
  const openPermission = (): void => {
    setCmdOpen(true)
    requestAnimationFrame(() => {
      const control = permissionRef.current
      ;(
        control?.querySelector<HTMLElement>('[aria-checked="true"]') ??
        control?.querySelector<HTMLElement>('button')
      )?.focus()
    })
  }
  const expandable = isDetected || permission !== undefined

  return (
    <div className={cn('py-3', !isDetected && 'opacity-70')}>
      <div className="flex flex-wrap items-start gap-3">
        <div className="flex size-7 shrink-0 items-center justify-center rounded-md border border-border/50 bg-background/50">
          <AgentIcon agent={agentId} size={16} />
        </div>
        <div className="flex-1 max-sm:min-w-0 sm:min-w-48">
          <div className="flex flex-wrap items-center gap-2">
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

        <div className="ml-auto flex shrink-0 items-center gap-1.5">
          {permission && permission.mode !== permission.expectedMode && (
            // Right-aligned against the controls so badges line up without reserving width on every row.
            <div className="mr-3 flex h-7 items-center">
              <AgentPermissionExceptionBadge
                label={label}
                permission={permission}
                onSelect={openPermission}
              />
            </div>
          )}
          <div className="grid grid-cols-[max-content_6.5rem_1.75rem_1.75rem] items-center gap-1.5">
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
                      ? translate('settings.agents.clearDefault', 'Clear default agent')
                      : translate(
                          'auto.components.settings.AgentsPane.5f986a9b92',
                          'Set as default'
                        )
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
              {expandable && (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => setCmdOpen((previous) => !previous)}
                  aria-label={
                    cmdOpen
                      ? translate(
                          'settings.agents.collapseAgentSettings',
                          'Collapse agent settings'
                        )
                      : translate('settings.agents.expandAgentSettings', 'Expand agent settings')
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
      </div>

      {expandable && cmdOpen && (
        <div className="mt-3 space-y-3 pl-10">
          {permission && (
            <AgentRowPermissionControl
              label={label}
              permission={permission}
              controlRef={permissionRef}
            />
          )}
          {isDetected && (
            <div>
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
              {environmentEditor ??
                ((defaultEnvSummary || envSummary) && (
                  <div className="mt-2">
                    <AgentDefaultEnvInput
                      key={`${agentId}:${envSummary}`}
                      defaultEnv={defaultEnv}
                      envOverride={envOverride}
                      onSaveEnv={onSaveEnv}
                    />
                  </div>
                ))}
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
      )}
    </div>
  )
}
