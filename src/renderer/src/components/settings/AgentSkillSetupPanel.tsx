import { bundledSkillSetupActionLabel } from './bundled-skill-setup-copy'
import { useActiveProjectSkillRuntime } from '@/hooks/useActiveProjectSkillRuntime'
import { buildAgentFeatureSkillInstallCommand } from '@/lib/agent-feature-install-commands'
import { buildSkillCommandForRuntime } from './CliSkillRuntimeSetup'
import { WslAgentSkillSetupPanel } from './WslAgentSkillSetupPanel'
import { useCallback } from 'react'
import { Download, Loader2, RefreshCw } from 'lucide-react'
import { IntegrationStatusPill } from '../integration-status-pill'
import { SkillPlanStatusPill, SkillUnsupportedStatusPill } from '../skills/SkillFreshnessStatusPill'
import { BundledSkillInstallStatus } from './BundledSkillInstallStatus'
import type { AgentSkillSetupPanelProps } from './agent-skill-setup-panel-props'
import { Button } from '../ui/button'
import {
  bundledSkillInstallNeedsAttention,
  useBundledSkillInstall
} from '@/hooks/use-bundled-skill-install'
import {
  recheckSurfacesAfterAgentSkillInstall,
  syncSurfacesAfterAgentSkillRecheck
} from './agent-skill-recheck-surface-sync'
import { useBundledSkillInstallAction } from '@/hooks/use-bundled-skill-install-action'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import { ManageInstalledSkillsButton } from './ManageInstalledSkillsButton'

function BundledAgentSkillSetupPanel({
  title,
  description,
  skillNames,
  target,
  installedSkillNames,
  installed,
  loading,
  error,
  installDisabled = false,
  leading,
  icon,
  variant = 'card',
  className,
  hideHeader = false,
  onBeforeInstall,
  showInstallWhenInstalled = true,
  showRecheckWhenInstalled = true,
  installLabel,
  installedInstallLabel,
  installVariant = 'outline',
  actionHint,
  footer,
  onRecheck,
  freshnessSkillName
}: AgentSkillSetupPanelProps): React.JSX.Element {
  const resolvedInstallLabel =
    installLabel ??
    translate('auto.components.settings.AgentSkillSetupPanel.installLabel', 'Install')
  const resolvedInstalledInstallLabel =
    installedInstallLabel ??
    translate('auto.components.settings.AgentSkillSetupPanel.updateLabel', 'Update')
  const recheckAfterInstall = useCallback(
    () => recheckSurfacesAfterAgentSkillInstall(onRecheck, freshnessSkillName),
    [freshnessSkillName, onRecheck]
  )
  const skillInstall = useBundledSkillInstall({ onFinished: recheckAfterInstall, target })
  const { state, ready, install } = skillInstall
  const installing = state.kind === 'installing'
  const activeSkillNames = installed ? (installedSkillNames ?? skillNames) : skillNames
  const action = useBundledSkillInstallAction(activeSkillNames, {
    enabled: true,
    refreshKey: state.kind,
    target
  })
  const effectivelyInstalled = installed || action.kind === 'none'
  const unsupported = action.kind === 'unsupported' ? action.reason : undefined
  const failed =
    !unsupported && (bundledSkillInstallNeedsAttention(state) || action.kind === 'attention')
  const installedButton: 'update' | 'replace' | null =
    action.kind === 'run' ? 'update' : action.kind === 'replace' ? 'replace' : null

  const plan = 'plan' in action ? action.plan : undefined
  const freshnessPill = unsupported ? (
    <SkillUnsupportedStatusPill reason={unsupported} />
  ) : action.kind === 'loading' || action.kind === 'unknown' ? (
    <IntegrationStatusPill tone={action.kind === 'loading' ? 'neutral' : 'attention'}>
      {action.kind === 'loading'
        ? translate('auto.components.skills.SkillFreshnessStatusPill.checking', 'Checking...')
        : translate('auto.components.skills.SkillFreshnessStatusPill.checkFailed', 'Check failed')}
    </IntegrationStatusPill>
  ) : (
    <SkillPlanStatusPill
      skillName={freshnessSkillName ?? activeSkillNames[0]}
      plan={plan ?? null}
      target={target}
    />
  )

  const startInstall = (): void => {
    if (installing) {
      return
    }
    void (async () => {
      try {
        await onBeforeInstall?.()
      } catch {
        return
      }
      await install(activeSkillNames, action.kind === 'replace' ? action.paths : undefined)
    })()
  }

  const actionRow = (
    <div className="mt-3 flex flex-wrap items-center gap-2">
      {action.kind !== 'none' &&
      action.kind !== 'unknown' &&
      !unsupported &&
      (!installed || (showInstallWhenInstalled && installedButton)) &&
      !failed ? (
        <Button
          type="button"
          variant={installVariant}
          size="sm"
          onClick={startInstall}
          disabled={installDisabled || installing || !ready || action.kind === 'loading'}
        >
          {installing ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <Download className="size-3.5" />
          )}
          {installing
            ? translate('auto.components.settings.AgentSkillSetupPanel.installing', 'Installing...')
            : installedButton === 'replace'
              ? translate(
                  'auto.components.settings.AgentSkillSetupPanel.replaceWithOrcaCopy',
                  "Replace with Orca's copy"
                )
              : action.kind === 'run' && action.changes
                ? bundledSkillSetupActionLabel(action.changes)
                : installed
                  ? resolvedInstalledInstallLabel
                  : resolvedInstallLabel}
        </Button>
      ) : null}
      {!installed || showRecheckWhenInstalled ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="gap-1.5"
          onClick={() => {
            void Promise.resolve(onRecheck()).then(() => {
              syncSurfacesAfterAgentSkillRecheck(freshnessSkillName)
            })
          }}
          disabled={loading}
        >
          <RefreshCw className={cn('size-3.5', loading && 'animate-spin')} />
          {translate('auto.components.settings.AgentSkillSetupPanel.c689392435', 'Re-check')}
        </Button>
      ) : null}
      {effectivelyInstalled && !unsupported ? (
        <ManageInstalledSkillsButton target={target} />
      ) : null}
      {ready ? null : (
        <p className="basis-full text-[12px] leading-snug text-muted-foreground">
          {translate(
            'auto.components.settings.AgentSkillSetupPanel.hostUnavailable',
            "Orca can't install skills on this workspace's machine yet."
          )}
        </p>
      )}
    </div>
  )

  return (
    <div
      className={cn(
        'min-w-0',
        variant === 'card' ? 'rounded-xl border border-border bg-muted/20' : null,
        className
      )}
    >
      <div className={variant === 'card' ? 'p-5' : 'pt-1.5'}>
        {hideHeader ? (
          <>
            {error ? <p className="text-[12px] text-destructive">{error}</p> : null}
            {/* hideHeader drops the title row; keep freshness so guided hubs still surface updates. */}
            {(effectivelyInstalled ||
              unsupported ||
              action.kind === 'loading' ||
              action.kind === 'unknown') &&
            !failed ? (
              <div className="mb-2">{freshnessPill}</div>
            ) : null}
          </>
        ) : (
          <div className="flex items-center gap-4">
            {typeof leading === 'function'
              ? leading(effectivelyInstalled && action.kind === 'none' && !failed)
              : leading}
            {icon ? (
              <div className="flex size-10 shrink-0 items-center justify-center rounded-lg border border-border bg-background text-foreground">
                {icon}
              </div>
            ) : null}
            <div className="min-w-0 flex-1 self-center">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <h3 className="text-[15px] font-semibold leading-tight text-foreground">{title}</h3>
                {unsupported || action.kind === 'loading' || action.kind === 'unknown' ? (
                  freshnessPill
                ) : failed ? (
                  <IntegrationStatusPill tone="attention">
                    {translate(
                      'auto.components.skills.skillPlanOpCopy.needsAttention',
                      'Needs attention'
                    )}
                  </IntegrationStatusPill>
                ) : loading && !installed ? (
                  <IntegrationStatusPill tone="neutral">
                    {translate(
                      'auto.components.settings.AgentSkillSetupPanel.68a468752e',
                      'Checking...'
                    )}
                  </IntegrationStatusPill>
                ) : effectivelyInstalled ? (
                  freshnessPill
                ) : (
                  <IntegrationStatusPill tone="attention">
                    {translate(
                      'auto.components.settings.AgentSkillSetupPanel.5289300939',
                      'Not installed'
                    )}
                  </IntegrationStatusPill>
                )}
              </div>
              {error ? <p className="mt-1 text-[12px] text-destructive">{error}</p> : null}
            </div>
          </div>
        )}
        <div className={cn('max-w-none', hideHeader ? null : 'mt-3')}>
          {description != null ? (
            <p className="text-[13px] leading-snug text-muted-foreground">{description}</p>
          ) : null}
          {actionRow}
          {hideHeader && action.kind === 'none' && state.kind === 'idle' ? (
            <p className="mt-2 text-xs text-muted-foreground">
              {translate('auto.components.skills.skillPlanOpCopy.installed', 'Installed')}
            </p>
          ) : null}
          <BundledSkillInstallStatus
            install={skillInstall}
            unsupported={unsupported}
            attention={
              action.kind === 'attention'
                ? { retry: startInstall, message: action.attentionMessage }
                : undefined
            }
            className="mt-2"
          />
          {actionHint ? <div className="mt-2">{actionHint}</div> : null}
        </div>
        {footer ? (
          <div className="mt-5 border-t border-border/60 pt-5">
            {typeof footer === 'function'
              ? footer('plan' in action ? action.plan : undefined)
              : footer}
          </div>
        ) : null}
      </div>
    </div>
  )
}

export function AgentSkillSetupPanel(props: AgentSkillSetupPanelProps): React.JSX.Element {
  const activeRuntime = useActiveProjectSkillRuntime()
  const runtime =
    props.terminalRuntime ?? (props.target === undefined ? activeRuntime.agentRuntime : undefined)
  // COMPAT(wsl-bridge): removed when WSL runs as an orcad host.
  if (runtime?.runtime === 'wsl') {
    return (
      <WslAgentSkillSetupPanel
        {...props}
        leading={
          typeof props.leading === 'function' ? props.leading(props.installed) : props.leading
        }
        footer={typeof props.footer === 'function' ? props.footer(undefined) : props.footer}
        command={buildSkillCommandForRuntime(
          buildAgentFeatureSkillInstallCommand(props.skillNames),
          runtime
        )}
        installedCommand={
          props.installedSkillNames
            ? buildSkillCommandForRuntime(
                buildAgentFeatureSkillInstallCommand(props.installedSkillNames),
                runtime
              )
            : undefined
        }
        terminalTitle={props.title}
        terminalAriaLabel={props.title}
        terminalWorktreeId={`wsl-agent-skill-setup-${props.skillNames.join('-')}`}
        terminalRuntime={runtime}
        terminalShellOverride="powershell.exe"
        installDisabled={
          props.installDisabled ||
          (props.terminalRuntime === undefined && Boolean(activeRuntime.installDisabledReason))
        }
        onBeforeOpenTerminal={props.onBeforeInstall}
      />
    )
  }
  return <BundledAgentSkillSetupPanel {...props} />
}
