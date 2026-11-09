import {
  useBundledSkillInstallAction,
  type BundledSkillInstallActionState
} from '@/hooks/use-bundled-skill-install-action'
import { bundledSkillSetupActionLabel } from '../skills/setup/bundled-skill-setup-copy'
import { useOnboardingSkillRuntime } from '@/hooks/use-onboarding-skill-runtime'
import { FeatureSetupInlineTerminal } from '../onboarding/FeatureSetupInlineTerminal'
import { buildAgentFeatureSkillInstallCommand } from '@/lib/skills/installation/agent-feature-install-commands'
import { buildSkillCommandForRuntime } from '../../lib/skill-runtime-command'
import type { OnboardingFeatureSetupRuntimeContext } from '../onboarding/onboarding-feature-setup-runtime'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Check, Download, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { useAppStore } from '@/store'
import { AgentCapabilityStatusNote, AgentCapabilityStatusPill } from './AgentCapabilityStatusBadges'
import {
  bundledSkillInstallNeedsAttention,
  useBundledSkillInstall,
  type BundledSkillInstall
} from '@/hooks/use-bundled-skill-install'
import { BundledSkillInstallStatus } from '../skills/setup/BundledSkillInstallStatus'
import {
  DEFAULT_ONBOARDING_FEATURE_SETUP_SELECTION,
  hasSelectedOnboardingFeatureSetup,
  onboardingFeatureSetupRunTelemetry,
  onboardingFeatureSetupSkillNames,
  runOnboardingFeatureSetup,
  type OnboardingFeatureSetupId,
  type OnboardingFeatureSetupSelection
} from '../onboarding/onboarding-feature-setup'
import {
  getDefaultAgentCapabilitySetupSelection,
  isAgentCapabilityReadinessChecking,
  isAgentCapabilityReadinessComplete,
  useAgentCapabilitySetupStatus,
  type AgentCapabilityInstallStatus
} from './agent-capability-setup-status'
import { translate } from '@/i18n/i18n'
import { useTranslate } from '@/i18n/use-translate'
import { capabilitiesSetupBusyLabel, capabilityToggleLabel } from './agent-capability-setup-copy'
import { AGENT_CAPABILITY_SETUP_ROWS } from './agent-capability-setup-rows'
import { track } from '@/lib/telemetry'

type AgentCapabilitiesSetupActionProps = {
  onOrchestrationSkillInstalledChange: (installed: boolean) => void
  onBrowserUseSkillInstalledChange: (installed: boolean) => void
}

export function AgentCapabilitiesSetupAction(
  props: AgentCapabilitiesSetupActionProps
): React.JSX.Element {
  const runtime = useOnboardingSkillRuntime()
  return <AgentCapabilitiesSetupForRuntime key={runtime.setupKey} {...props} runtime={runtime} />
}

function AgentCapabilitiesSetupForRuntime(
  props: AgentCapabilitiesSetupActionProps & {
    runtime: ReturnType<typeof useOnboardingSkillRuntime>
  }
): React.JSX.Element {
  const { onBrowserUseSkillInstalledChange, onOrchestrationSkillInstalledChange } = props
  const { readiness, installStatus } = useAgentCapabilitySetupStatus()
  const featureSetupDefaultsAppliedRef = useRef(false)
  const featureSetupChangedByUserRef = useRef(false)
  const [featureSetup, setFeatureSetup] = useState<OnboardingFeatureSetupSelection>(
    DEFAULT_ONBOARDING_FEATURE_SETUP_SELECTION
  )
  const [setupBusyLabel, setSetupBusyLabel] = useState<string | null>(null)
  const recordFeatureInteraction = useAppStore((s) => s.recordFeatureInteraction)
  const activeRuntime = props.runtime
  const [wslSetup, setWslSetup] = useState<{
    command: string
    runtime: OnboardingFeatureSetupRuntimeContext
    selection: OnboardingFeatureSetupSelection
  } | null>(null)
  const legacyWsl = activeRuntime.agentRuntime?.runtime === 'wsl'
  const skillInstall = useBundledSkillInstall({ target: activeRuntime.bundledSkillTarget })
  const installSkills = skillInstall.install
  const installAction = useBundledSkillInstallAction(
    onboardingFeatureSetupSkillNames(featureSetup),
    {
      enabled: !legacyWsl && hasSelectedOnboardingFeatureSetup(featureSetup),
      target: activeRuntime.bundledSkillTarget,
      refreshKey: skillInstall.state.kind
    }
  )
  useEffect(() => {
    onBrowserUseSkillInstalledChange(readiness.browserUseSkillInstalled)
  }, [onBrowserUseSkillInstalledChange, readiness.browserUseSkillInstalled])
  useEffect(() => {
    onOrchestrationSkillInstalledChange(readiness.orchestrationSkillInstalled)
  }, [onOrchestrationSkillInstalledChange, readiness.orchestrationSkillInstalled])
  useEffect(() => {
    if (featureSetupDefaultsAppliedRef.current || featureSetupChangedByUserRef.current) {
      return
    }
    if (isAgentCapabilityReadinessChecking(readiness)) {
      return
    }
    featureSetupDefaultsAppliedRef.current = true
    setFeatureSetup(getDefaultAgentCapabilitySetupSelection(readiness))
  }, [readiness])
  const handleFeatureSetupChange = useCallback((value: OnboardingFeatureSetupSelection): void => {
    featureSetupChangedByUserRef.current = true
    setFeatureSetup(value)
  }, [])
  const handleStartFeatureSetup = useCallback(async (): Promise<void> => {
    if (setupBusyLabel !== null) {
      return
    }
    setSetupBusyLabel(capabilitiesSetupBusyLabel())
    try {
      const result = await runOnboardingFeatureSetup(featureSetup)
      if (featureSetup.browserUse) {
        recordFeatureInteraction('agent-browser-setup')
      }
      if (featureSetup.computerUse) {
        recordFeatureInteraction('computer-use-setup')
      }
      if (featureSetup.orchestration) {
        recordFeatureInteraction('agent-orchestration-setup')
      }
      const firstWarning = result.warnings[0]
      if (firstWarning) {
        toast.warning(
          translate(
            'auto.components.feature.wall.AgentCapabilitiesSetupAction.1aa657d8f4',
            'Some capability setup needs attention'
          ),
          {
            description: firstWarning.message
          }
        )
      }
      // COMPAT(wsl-bridge): removed when WSL runs as an orcad host.
      if (legacyWsl) {
        const command = buildAgentFeatureSkillInstallCommand(result.skillNames)
        await window.api.ui.writeClipboardText(
          buildSkillCommandForRuntime(command, activeRuntime.agentRuntime)
        )
        setWslSetup({ command, runtime: activeRuntime, selection: featureSetup })
        return
      }
      const installState = await installSkills(
        result.skillNames,
        installAction.kind === 'replace' ? installAction.paths : undefined
      )
      const telemetry =
        installState && onboardingFeatureSetupRunTelemetry(featureSetup, result, installState)
      if (telemetry) {
        track('onboarding_feature_setup_run', telemetry)
      }
      if (installState?.kind === 'done' && installState.summary.ok) {
        toast.success(
          translate(
            'auto.components.feature.wall.AgentCapabilitiesSetupAction.c605f51f2b',
            'Capability setup ready'
          )
        )
      }
      if (result.computerUsePermissionsOpened) {
        toast.message(
          translate(
            'auto.components.feature.wall.AgentCapabilitiesSetupAction.e9eb197e12',
            'Opened Computer Use permissions'
          )
        )
      }
    } finally {
      setSetupBusyLabel(null)
    }
  }, [
    activeRuntime,
    featureSetup,
    installSkills,
    installAction,
    legacyWsl,
    recordFeatureInteraction,
    setupBusyLabel
  ])

  return (
    <div className="space-y-5">
      {/* COMPAT(wsl-bridge): removed when WSL runs as an orcad host. */}
      {wslSetup ? (
        <FeatureSetupInlineTerminal
          command={wslSetup.command}
          runtimeContext={wslSetup.runtime}
          selection={wslSetup.selection}
        />
      ) : (
        <AgentCapabilitySetupControls
          featureSetup={featureSetup}
          onFeatureSetupChange={handleFeatureSetupChange}
          installAction={legacyWsl ? undefined : installAction}
          skillInstall={
            legacyWsl
              ? { ...skillInstall, ready: !activeRuntime.installDisabledReason }
              : skillInstall
          }
          setupBusyLabel={setupBusyLabel}
          onStartFeatureSetup={() => void handleStartFeatureSetup()}
          allReady={isAgentCapabilityReadinessComplete(readiness)}
          installStatus={installStatus}
        />
      )}
    </div>
  )
}

function AgentCapabilitySetupControls(props: {
  featureSetup: OnboardingFeatureSetupSelection
  onFeatureSetupChange: (value: OnboardingFeatureSetupSelection) => void
  skillInstall: BundledSkillInstall
  installAction?: BundledSkillInstallActionState
  setupBusyLabel: string | null
  onStartFeatureSetup: () => void
  allReady: boolean
  installStatus: Record<OnboardingFeatureSetupId, AgentCapabilityInstallStatus>
}): React.JSX.Element {
  const t = useTranslate()
  const hasSelectedFeatures = hasSelectedOnboardingFeatureSetup(props.featureSetup)
  const installState = props.skillInstall.state
  const showSetupAction =
    installState.kind !== 'unsupported' &&
    props.installAction?.kind !== 'unsupported' &&
    !bundledSkillInstallNeedsAttention(installState) &&
    props.installAction?.kind !== 'attention'
  // Why: a disabled install button is noise once everything is set up.
  const showAllReady =
    (props.installAction?.kind === 'none' || (props.allReady && !hasSelectedFeatures)) &&
    !props.setupBusyLabel

  return (
    <>
      <AgentCapabilitySetupChecklist
        value={props.featureSetup}
        onChange={props.onFeatureSetupChange}
        installStatus={props.installStatus}
      />
      {showSetupAction && showAllReady ? (
        <p className="mt-6 flex items-center gap-1.5 text-sm text-muted-foreground">
          <Check className="size-4" />
          {t('auto.components.skills.skillPlanOpCopy.installed', 'Installed')}
        </p>
      ) : showSetupAction ? (
        <div className="mt-6 flex items-center">
          <Button
            type="button"
            variant="default"
            className="shrink-0"
            disabled={
              !hasSelectedFeatures ||
              Boolean(props.setupBusyLabel) ||
              !props.skillInstall.ready ||
              props.installAction?.kind === 'loading'
            }
            onClick={props.onStartFeatureSetup}
          >
            {props.setupBusyLabel ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Download className="size-4" />
            )}
            {props.setupBusyLabel ??
              (props.installAction?.kind === 'replace'
                ? t(
                    'auto.components.settings.AgentSkillSetupPanel.replaceWithOrcaCopy',
                    "Replace with Orca's copy"
                  )
                : props.installAction?.kind === 'run' && props.installAction.changes
                  ? bundledSkillSetupActionLabel(props.installAction.changes, t)
                  : t(
                      'auto.components.feature.wall.AgentCapabilitiesSetupAction.installSkills',
                      'Install skills'
                    ))}
          </Button>
        </div>
      ) : null}
      <BundledSkillInstallStatus
        install={props.skillInstall}
        unsupported={
          props.installAction?.kind === 'unsupported' ? props.installAction.reason : undefined
        }
        attention={
          props.installAction?.kind === 'attention'
            ? { retry: props.onStartFeatureSetup, message: props.installAction.attentionMessage }
            : undefined
        }
        className="mt-4"
      />
    </>
  )
}

function AgentCapabilitySetupChecklist(props: {
  value: OnboardingFeatureSetupSelection
  onChange: (value: OnboardingFeatureSetupSelection) => void
  installStatus: Record<OnboardingFeatureSetupId, AgentCapabilityInstallStatus>
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <section className="mt-6">
      <div className="grid gap-3 md:grid-cols-3">
        {AGENT_CAPABILITY_SETUP_ROWS.map((row) => {
          const selected = props.value[row.id]
          const installStatus = props.installStatus[row.id]
          return (
            <button
              key={row.id}
              type="button"
              role="checkbox"
              aria-checked={selected}
              aria-label={capabilityToggleLabel(selected, row.title, t)}
              className={cn(
                'flex min-h-24 flex-col rounded-lg border px-4 py-3.5 text-left transition-colors',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                selected ? 'border-foreground/60 bg-accent' : 'border-border hover:bg-accent/60'
              )}
              onClick={() => props.onChange({ ...props.value, [row.id]: !selected })}
            >
              <span className="flex items-start justify-between gap-3">
                <span className="grid size-7 place-items-center rounded-md bg-muted text-foreground">
                  {row.icon}
                </span>
                <span className="flex items-center gap-2">
                  <AgentCapabilityStatusPill status={installStatus} />
                  {/* Why: an empty circle on an installed card reads as "not done"; show it only when it means something. */}
                  {selected || !installStatus.installed ? (
                    <span
                      aria-hidden
                      className={cn(
                        'flex size-5 items-center justify-center rounded-full border transition-colors',
                        selected
                          ? 'border-foreground bg-foreground text-background'
                          : 'border-border'
                      )}
                    >
                      {selected ? <Check className="size-3" strokeWidth={3} /> : null}
                    </span>
                  ) : null}
                </span>
              </span>
              <span className="mt-3 text-sm font-medium text-foreground">{row.title}</span>
              <span className="mt-1 text-xs leading-snug text-muted-foreground">
                {row.description}
              </span>
              <AgentCapabilityStatusNote status={installStatus} />
            </button>
          )
        })}
      </div>
    </section>
  )
}
