import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { Check, Globe2, Loader2, MonitorCog, Terminal, Workflow } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { useAppStore } from '@/store'
import { FeatureSetupInlineTerminal } from '../onboarding/FeatureSetupInlineTerminal'
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
  useAgentCapabilitySetupStatus,
  type AgentCapabilityInstallStatus
} from './agent-capability-setup-status'

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
  const [setupBusyLabel, setSetupBusyLabel] = useState<string | null>(null)
  const recordFeatureInteraction = useAppStore((s) => s.recordFeatureInteraction)
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
    if (setupBusyLabel !== null || featureSetupCommand !== null) {
      return
    }
    setSetupBusyLabel('Setting up capabilities...')
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
        toast.warning('Some capability setup needs attention', {
          description: firstWarning.message
        })
      }
      if (result.skillCommandsCopied) {
        toast.success('Capability setup ready', {
          description: 'Skill command copied and inserted below for review.'
        })
      }
      if (result.computerUsePermissionsOpened) {
        toast.message('Opened Computer Use permissions')
      }
      if (result.skillInstallCommand) {
        setFeatureSetupCommandSelection(featureSetup)
        setFeatureSetupCommand(result.skillInstallCommand)
      }
    } finally {
      setSetupBusyLabel(null)
    }
  }, [featureSetup, featureSetupCommand, recordFeatureInteraction, setupBusyLabel])

  return (
    <div className="space-y-5">
      <AgentCapabilitySetupControls
        featureSetup={featureSetup}
        onFeatureSetupChange={handleFeatureSetupChange}
        featureSetupCommand={featureSetupCommand}
        featureSetupCommandSelection={featureSetupCommandSelection}
        setupBusyLabel={setupBusyLabel}
        onStartFeatureSetup={() => void handleStartFeatureSetup()}
        installStatus={capabilitySetupStatus.installStatus}
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
    title: 'Agent Orchestration',
    description:
      'Let agents coordinate through Orca to keep large, multi-step tasks moving to completion.',
    icon: <Workflow className="size-4" />
  },
  {
    id: 'browserUse',
    title: 'Agent Browser Use',
    description:
      "Give agents direct access to Orca's browser so they can test pages, capture screenshots, and act on what they see.",
    icon: <Globe2 className="size-4" />
  },
  {
    id: 'computerUse',
    title: 'Computer Use',
    description:
      'Let agents control the desktop, moving the cursor, clicking, and typing in any app.',
    icon: <MonitorCog className="size-4" />
  }
]

function AgentCapabilitySetupControls(props: {
  featureSetup: OnboardingFeatureSetupSelection
  onFeatureSetupChange: (value: OnboardingFeatureSetupSelection) => void
  featureSetupCommand: string | null
  featureSetupCommandSelection: OnboardingFeatureSetupSelection | null
  setupBusyLabel: string | null
  onStartFeatureSetup: () => void
  installStatus: Record<OnboardingFeatureSetupId, AgentCapabilityInstallStatus>
}): React.JSX.Element {
  const hasSelectedFeatures = hasSelectedOnboardingFeatureSetup(props.featureSetup)
  const showSetupAction = !props.featureSetupCommand

  return (
    <>
      <AgentCapabilitySetupChecklist
        value={props.featureSetup}
        onChange={props.onFeatureSetupChange}
        installStatus={props.installStatus}
      />
      {showSetupAction ? (
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
            {props.setupBusyLabel ?? 'Install CLI & Skills'}
          </Button>
        </div>
      ) : null}
      {props.featureSetupCommand ? (
        <FeatureSetupInlineTerminal
          command={props.featureSetupCommand}
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

function AgentCapabilityStatusNote(props: {
  status: AgentCapabilityInstallStatus
}): React.JSX.Element {
  if (props.status.installed) {
    return (
      <span className="mt-2 flex flex-wrap items-center gap-1.5">
        <span className="rounded-full border border-green-500/45 bg-green-500/10 px-2 py-0.5 text-[11px] font-semibold leading-none text-green-700 dark:text-green-300">
          Installed
        </span>
        {props.status.label !== 'Installed' ? (
          <span
            className={cn(
              'text-xs font-medium',
              getAgentCapabilityStatusClassName(props.status.tone)
            )}
          >
            {props.status.label}
          </span>
        ) : null}
      </span>
    )
  }

  return (
    <span
      className={cn(
        'mt-1 text-xs font-medium',
        getAgentCapabilityStatusClassName(props.status.tone)
      )}
    >
      {props.status.label}
    </span>
  )
}
