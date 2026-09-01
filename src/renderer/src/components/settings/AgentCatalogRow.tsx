import { useState } from 'react'
import { Copy, ExternalLink } from 'lucide-react'
import type { TuiAgent } from '../../../../shared/tui-agent'
import { AgentIcon } from '@/lib/agent-catalog'
import { translate } from '@/i18n/i18n'
import type { AgentSessionSourceHomeControl } from './codex-session-source-home-control'
import { AgentSessionSourceHomeInput } from './codex-session-source-home-control'
import { stringifyAgentDefaultEnvDraft } from './agent-default-env-draft'
import {
  AgentCommandOverrideInput,
  AgentDefaultArgsInput,
  AgentDefaultEnvInput
} from './AgentLaunchDefaultsEditor'
import { AgentRowAction, AgentSettingsRow } from './AgentSettingsRow'

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
  onSetDefault?: () => void
  onSetEnabled: (enabled: boolean) => void
  onSaveOverride: (value: string) => void
  onSaveArgs: (value: string) => void
  onSaveEnv: (value: Record<string, string>) => void
  onDuplicateAsCustom: () => void
  duplicateAsCustomDisabled: boolean
  sessionSourceHome?: AgentSessionSourceHomeControl
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
  onDuplicateAsCustom,
  duplicateAsCustomDisabled,
  sessionSourceHome
}: AgentCatalogRowProps): React.JSX.Element {
  const envSummary = stringifyAgentDefaultEnvDraft(envOverride)
  const defaultEnvSummary = stringifyAgentDefaultEnvDraft(defaultEnv)
  const [cmdOpen, setCmdOpen] = useState(
    Boolean(cmdOverride) || argsOverride !== defaultArgs || envSummary !== defaultEnvSummary
  )

  return (
    <AgentSettingsRow
      label={label}
      icon={<AgentIcon agent={agentId} size={16} />}
      summary={
        <>
          {cmdOverride ? (
            <span>
              <span className="text-muted-foreground/60 line-through">{defaultCmd}</span>
              <span className="ml-1.5 text-foreground/80">{cmdOverride}</span>
            </span>
          ) : (
            defaultCmd
          )}
          {argsOverride ? <span className="ml-1.5 text-foreground/70">{argsOverride}</span> : null}
          {envSummary ? <span className="ml-1.5 text-foreground/60">{envSummary}</span> : null}
        </>
      }
      isEnabled={isEnabled}
      isDefault={isDefault}
      onSetEnabled={onSetEnabled}
      onSetDefault={isDetected ? onSetDefault : undefined}
      muted={!isDetected}
      firstAction={
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
      }
      secondAction={
        <AgentRowAction
          label={translate(
            'auto.components.settings.AgentCatalogRow.duplicateAsCustom',
            'Duplicate {{value0}} as custom agent',
            { value0: label }
          )}
          disabled={duplicateAsCustomDisabled}
          onClick={onDuplicateAsCustom}
        >
          <Copy className="size-3.5" />
        </AgentRowAction>
      }
      detailsOpen={cmdOpen}
      onToggleDetails={isDetected ? () => setCmdOpen((previous) => !previous) : undefined}
    >
      {isDetected ? (
        <>
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
        </>
      ) : null}
    </AgentSettingsRow>
  )
}
