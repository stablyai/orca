import type { ReactNode } from 'react'
import type { SetupConfig } from '../../../../shared/orca-hook-setup-config'
import type { SetupDecision } from '../../../../shared/worktree/create-types'
import type { SetupAgentStartupPolicy } from '../../../../shared/orca-yaml-hook-types'
import { SettingsSwitch } from '@/components/settings/SettingsFormControls'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { SetupCommandPreview } from './SetupCommandPreview'
import { WorkspaceSetupChoice } from './WorkspaceSetupChoice'
import type { WorkspaceSetupCopy } from './workspace-setup-section-model'

function renderSetupDescription(text: string): ReactNode {
  return <div className="text-xs text-muted-foreground">{text}</div>
}

export function WorkspaceSetupSection({
  setupConfig,
  copy,
  requiresExplicitSetupChoice,
  resolvedSetupDecision,
  setupDecision,
  onSetupDecisionChange,
  shouldWaitForSetupCheck = false,
  startupPolicy,
  unavailable,
  renderDescription = renderSetupDescription
}: {
  setupConfig: SetupConfig | null
  copy: WorkspaceSetupCopy
  requiresExplicitSetupChoice: boolean
  resolvedSetupDecision: SetupDecision | null
  setupDecision: 'run' | 'skip' | null
  onSetupDecisionChange: (decision: 'run' | 'skip') => void
  shouldWaitForSetupCheck?: boolean
  startupPolicy?: {
    value: SetupAgentStartupPolicy
    onChange: (value: SetupAgentStartupPolicy) => void
    label: string
  }
  unavailable?: { message: string; retryLabel: string; checking: boolean; retry: () => void }
  renderDescription?: (text: string) => ReactNode
}): React.JSX.Element {
  return (
    <div className="space-y-2">
      {setupConfig ? (
        <>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <label className="text-xs font-medium text-muted-foreground">{copy.configLabel}</label>
            <span className="rounded border border-border/50 bg-muted/30 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
              {copy.sourceLabel}
            </span>
          </div>
          <SetupCommandPreview setupConfig={setupConfig} />
        </>
      ) : null}
      {unavailable ? (
        <div className="space-y-2">
          <p className="text-sm text-muted-foreground">{unavailable.message}</p>
          <Button variant="outline" disabled={unavailable.checking} onClick={unavailable.retry}>
            {unavailable.retryLabel}
          </Button>
        </div>
      ) : null}
      {!requiresExplicitSetupChoice || startupPolicy ? (
        <div className="rounded-md border border-border/60 bg-muted/25">
          {requiresExplicitSetupChoice ? null : (
            <div className="flex items-center justify-between gap-3 p-3">
              <span className="text-xs font-medium text-foreground">{copy.runLabel}</span>
              <SettingsSwitch
                checked={resolvedSetupDecision === 'run'}
                onChange={() =>
                  onSetupDecisionChange(resolvedSetupDecision === 'run' ? 'skip' : 'run')
                }
                ariaLabel={copy.runLabel}
              />
            </div>
          )}
          {startupPolicy ? (
            <div className="flex items-start justify-between gap-3 p-3">
              <span className={cn('min-w-0', resolvedSetupDecision === 'run' ? '' : 'opacity-50')}>
                <span className="block text-xs font-medium text-foreground">
                  {startupPolicy.label}
                </span>
              </span>
              <SettingsSwitch
                checked={startupPolicy.value === 'wait-for-setup'}
                disabled={resolvedSetupDecision !== 'run'}
                onChange={() =>
                  startupPolicy.onChange(
                    startupPolicy.value === 'wait-for-setup'
                      ? 'start-immediately'
                      : 'wait-for-setup'
                  )
                }
                ariaLabel={startupPolicy.label}
              />
            </div>
          ) : null}
        </div>
      ) : null}
      {requiresExplicitSetupChoice ? (
        <div className="space-y-2">
          {setupConfig ? (
            <div className="text-[11px] font-medium text-muted-foreground">{copy.askLabel}</div>
          ) : null}
          <WorkspaceSetupChoice
            decision={setupDecision}
            onChange={onSetupDecisionChange}
            runLabel={copy.runButtonLabel}
            skipLabel={copy.skipButtonLabel}
            disabled={Boolean(unavailable)}
          />
          {!setupDecision
            ? renderDescription(shouldWaitForSetupCheck ? copy.checking : copy.help)
            : null}
        </div>
      ) : null}
    </div>
  )
}
