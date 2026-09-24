import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { Check, Globe2, Loader2, MonitorCog, Terminal, Workflow } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { useActiveProjectSkillRuntime } from '@/hooks/useActiveProjectSkillRuntime'
import { useAppStore } from '@/store'
import { FeatureSetupInlineTerminal } from '../onboarding/FeatureSetupInlineTerminal'
import type { OnboardingFeatureSetupRuntimeContext } from '../onboarding/onboarding-feature-setup-runtime'
import {
  DEFAULT_ONBOARDING_FEATURE_SETUP_SELECTION,
  hasSelectedOnboardingFeatureSetup,
  runOnboardingFeatureSetup,
  type OnboardingFeatureSetupId,
  type OnboardingFeatureSetupSelection
} from '../onboarding/onboarding-feature-setup'
import {
  getAgentCapabilityStatusClassName,
  getDefaultAgentCapabilitySetupSelection,
  isAgentCapabilityReadinessChecking,
  isAgentCapabilityReadinessComplete,
  useAgentCapabilitySetupStatus,
  type AgentCapabilityInstallStatus
} from './agent-capability-setup-status'
import { isOrcaCliRegistrationRequired } from '@/lib/agent-skill-cli-prerequisite'
import { translate } from '@/i18n/i18n'

export function AgentCapabilitiesSetupAction(props: {
  onOrchestrationSkillInstalledChange: (installed: boolean) => void
  onBrowserUseSkillInstalledChange: (installed: boolean) => void
}): React.JSX.Element {
  const { onBrowserUseSkillInstalledChange, onOrchestrationSkillInstalledChange } = props
  const capabilitySetupStatus = useAgentCapabilitySetupStatus()
  const { readiness } = capabilitySetupStatus
  const featureSetupDefaultsAppliedRef = useRef(false)
  const featureSetupChangedByUserRef = useRef(false)
  const [featureSetup, setFeatureSetup] = useState<OnboardingFeatureSetupSelection>(
    DEFAULT_ONBOARDING_FEATURE_SETUP_SELECTION
  )
  const [featureSetupCommand, setFeatureSetupCommand] = useState<string | null>(null)
  const [featureSetupCommandSelection, setFeatureSetupCommandSelection] =
    useState<OnboardingFeatureSetupSelection | null>(null)
  const [featureSetupRuntime, setFeatureSetupRuntime] =
    useState<OnboardingFeatureSetupRuntimeContext | null>(null)
  const [setupBusyLabel, setSetupBusyLabel] = useState<string | null>(null)
  const recordFeatureInteraction = useAppStore((s) => s.recordFeatureInteraction)
  const activeSkillRuntime = useActiveProjectSkillRuntime()
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
  const handleStartFeatureSetup = useCallback(
    async (selection: OnboardingFeatureSetupSelection = featureSetup): Promise<void> => {
      if (setupBusyLabel !== null || featureSetupCommand !== null) {
        return
      }
      setSetupBusyLabel('Setting up capabilities...')
      try {
        const result = await runOnboardingFeatureSetup(selection, undefined, activeSkillRuntime)
        if (selection.browserUse) {
          recordFeatureInteraction('agent-browser-setup')
        }
        if (selection.computerUse) {
          recordFeatureInteraction('computer-use-setup')
        }
        if (selection.orchestration) {
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
        if (result.skillCommandsCopied) {
          toast.success(
            translate(
              'auto.components.feature.wall.AgentCapabilitiesSetupAction.c605f51f2b',
              'Capability setup ready'
            ),
            {
              description: translate(
                'auto.components.feature.wall.AgentCapabilitiesSetupAction.3a59452a67',
                'Skill command copied and inserted below for review.'
              )
            }
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
        if (result.skillInstallCommand) {
          setFeatureSetupCommandSelection(selection)
          setFeatureSetupRuntime(activeSkillRuntime)
          setFeatureSetupCommand(result.skillInstallCommand)
        }
      } finally {
        setSetupBusyLabel(null)
      }
    },
    [
      activeSkillRuntime,
      featureSetup,
      featureSetupCommand,
      recordFeatureInteraction,
      setupBusyLabel
    ]
  )

  return (
    <div className="space-y-5">
      <AgentCapabilitySetupControls
        featureSetup={featureSetup}
        onFeatureSetupChange={handleFeatureSetupChange}
        featureSetupCommand={featureSetupCommand}
        featureSetupCommandSelection={featureSetupCommandSelection}
        featureSetupRuntime={featureSetupRuntime}
        setupBusyLabel={setupBusyLabel}
        onStartFeatureSetup={() => void handleStartFeatureSetup()}
        onUpdateAll={() => void handleStartFeatureSetup(DEFAULT_ONBOARDING_FEATURE_SETUP_SELECTION)}
        allReady={isAgentCapabilityReadinessComplete(readiness)}
        installStatus={capabilitySetupStatus.installStatus}
        cliRequired={isOrcaCliRegistrationRequired(activeSkillRuntime.agentRuntime)}
      />
    </div>
  )
}

type AgentCapabilitySetupRow = {
  id: OnboardingFeatureSetupId
  title: string
  description: string
  icon: ReactNode
}

const AGENT_CAPABILITY_SETUP_ROWS: readonly AgentCapabilitySetupRow[] = [
  {
    id: 'orchestration',
    get title() {
      return translate(
        'auto.components.feature.wall.AgentCapabilitiesSetupAction.ac07f8887f',
        'Agent Orchestration'
      )
    },
    get description() {
      return translate(
        'auto.components.feature.wall.AgentCapabilitiesSetupAction.c61c91e642',
        'Let agents coordinate through Orca to keep large, multi-step tasks moving to completion.'
      )
    },
    icon: <Workflow className="size-4" />
  },
  {
    id: 'browserUse',
    get title() {
      return translate(
        'auto.components.feature.wall.AgentCapabilitiesSetupAction.e638da007a',
        'Agent Browser Use'
      )
    },
    get description() {
      return translate(
        'auto.components.feature.wall.AgentCapabilitiesSetupAction.5e8fe5a72d',
        "Give agents direct access to Orca's browser so they can test pages, capture screenshots, and act on what they see."
      )
    },
    icon: <Globe2 className="size-4" />
  },
  {
    id: 'computerUse',
    get title() {
      return translate(
        'auto.components.feature.wall.AgentCapabilitiesSetupAction.362a07517d',
        'Computer Use'
      )
    },
    get description() {
      return translate(
        'auto.components.feature.wall.AgentCapabilitiesSetupAction.1b51644c2d',
        'Let agents control the desktop, moving the cursor, clicking, and typing in any app.'
      )
    },
    icon: <MonitorCog className="size-4" />
  }
]

function AgentCapabilitySetupControls(props: {
  featureSetup: OnboardingFeatureSetupSelection
  onFeatureSetupChange: (value: OnboardingFeatureSetupSelection) => void
  featureSetupCommand: string | null
  featureSetupCommandSelection: OnboardingFeatureSetupSelection | null
  featureSetupRuntime: OnboardingFeatureSetupRuntimeContext | null
  setupBusyLabel: string | null
  onStartFeatureSetup: () => void
  onUpdateAll: () => void
  allReady: boolean
  installStatus: Record<OnboardingFeatureSetupId, AgentCapabilityInstallStatus>
  cliRequired: boolean
}): React.JSX.Element {
  const hasSelectedFeatures = hasSelectedOnboardingFeatureSetup(props.featureSetup)
  const showSetupAction = !props.featureSetupCommand
  // Why: a disabled install button is noise once everything is set up; offer an update instead.
  const showAllReady = props.allReady && !hasSelectedFeatures && !props.setupBusyLabel

  return (
    <>
      <AgentCapabilitySetupChecklist
        value={props.featureSetup}
        onChange={props.onFeatureSetupChange}
        installStatus={props.installStatus}
      />
      {showSetupAction && showAllReady ? (
        <div className="mt-6 flex items-center gap-3">
          <span className="flex items-center gap-1.5 text-sm font-medium text-status-success">
            <Check className="size-4" />
            {translate(
              'auto.components.feature.wall.AgentCapabilitiesSetupAction.allInstalled',
              'All skills installed'
            )}
          </span>
          <Button type="button" variant="ghost" size="sm" onClick={props.onUpdateAll}>
            {translate(
              'auto.components.feature.wall.AgentCapabilitiesSetupAction.updateSkills',
              'Update skills'
            )}
          </Button>
        </div>
      ) : showSetupAction ? (
        <div className="mt-6 flex items-center">
          <Button
            type="button"
            variant="default"
            className="shrink-0"
            disabled={!hasSelectedFeatures || Boolean(props.setupBusyLabel)}
            onClick={props.onStartFeatureSetup}
          >
            {props.setupBusyLabel ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Terminal className="size-4" />
            )}
            {props.setupBusyLabel ??
              (props.cliRequired
                ? translate(
                    'auto.components.feature.wall.AgentCapabilitiesSetupAction.c89534cbe9',
                    'Install CLI & Skills'
                  )
                : translate(
                    'auto.components.feature.wall.AgentCapabilitiesSetupAction.installSkills',
                    'Install Skills'
                  ))}
          </Button>
        </div>
      ) : null}
      {props.featureSetupCommand ? (
        <FeatureSetupInlineTerminal
          command={props.featureSetupCommand}
          runtimeContext={props.featureSetupRuntime ?? undefined}
          selection={props.featureSetupCommandSelection ?? props.featureSetup}
        />
      ) : null}
    </>
  )
}

function AgentCapabilitySetupChecklist(props: {
  value: OnboardingFeatureSetupSelection
  onChange: (value: OnboardingFeatureSetupSelection) => void
  installStatus: Record<OnboardingFeatureSetupId, AgentCapabilityInstallStatus>
}): React.JSX.Element {
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
              aria-label={`${selected ? 'Disable' : 'Enable'} ${row.title}`}
              className={cn(
                'flex min-h-24 flex-col rounded-lg border px-4 py-3 text-left transition-colors',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
                selected
                  ? 'border-ring bg-accent text-foreground ring-2 ring-ring/25'
                  : 'border-border bg-muted/20 text-muted-foreground hover:bg-muted/40'
              )}
              onClick={() => props.onChange({ ...props.value, [row.id]: !selected })}
            >
              <span className="flex items-start justify-between gap-3">
                <span
                  className={cn(
                    'flex size-8 items-center justify-center rounded-lg border',
                    selected
                      ? 'border-border bg-background text-foreground'
                      : 'border-border bg-muted/40'
                  )}
                >
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
                          ? 'border-primary bg-primary text-primary-foreground'
                          : 'border-border bg-background'
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

// Why: pills sit top-right so they line up across cards regardless of description length.
function AgentCapabilityStatusPill(props: {
  status: AgentCapabilityInstallStatus
}): React.JSX.Element | null {
  if (props.status.unavailable) {
    return (
      <span className="rounded-full border border-border px-2 py-0.5 text-[11px] font-semibold leading-none text-muted-foreground">
        {props.status.label}
      </span>
    )
  }
  if (!props.status.installed) {
    return null
  }
  return (
    <span className="rounded-full border border-status-success-border bg-status-success-background px-2 py-0.5 text-[11px] font-semibold leading-none text-status-success">
      {translate(
        'auto.components.feature.wall.AgentCapabilitiesSetupAction.b8dc9dd8a2',
        'Installed'
      )}
    </span>
  )
}

/** Secondary status text (checking, errors, pending actions); installed/unavailable live in the pill. */
function AgentCapabilityStatusNote(props: {
  status: AgentCapabilityInstallStatus
}): React.JSX.Element | null {
  if (props.status.unavailable || props.status.tone === 'ready') {
    return null
  }
  return (
    <span
      className={cn(
        'mt-2 text-xs font-medium',
        getAgentCapabilityStatusClassName(props.status.tone)
      )}
    >
      {props.status.label}
    </span>
  )
}
