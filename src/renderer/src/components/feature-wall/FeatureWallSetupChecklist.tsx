import { useCallback, useEffect, useMemo } from 'react'
import { ArrowUpRight, Check } from 'lucide-react'
import type {
  FeatureWallSetupStep,
  FeatureWallSetupStepId
} from '../../../../shared/feature-wall-setup-steps'
import { getFeatureWallSetupStepsForSection } from '../../../../shared/feature-wall-setup-steps'
import { cn } from '@/lib/utils'
import type { FeatureWallSetupProgress } from './feature-wall-setup-progress'
import { usePrefersReducedMotion } from './feature-wall-modal-helpers'
import { TasksAnimatedVisual } from './TasksAnimatedVisual'
import { AgentCapabilitiesSetupAction } from './AgentCapabilitiesSetupAction'
import {
  AddReposAction,
  SetupScriptAction,
  TwoAgentsAction,
  WorkspacesAction
} from './FeatureWallSetupWorkflowActions'
import { SetupStepPreview } from './SetupStepPreview'
import { Button } from '@/components/ui/button'
import { GitHubRow, LinearRow } from '../onboarding/IntegrationsStep'
import { AgentStep } from '../onboarding/AgentStep'
import { NotificationStep } from '../onboarding/NotificationStep'
import { useAppStore } from '@/store'
import type { TuiAgent } from '../../../../shared/types'

type FeatureWallSetupChecklistProps = {
  activeStep: FeatureWallSetupStep | null
  progress: FeatureWallSetupProgress
  onSelectStep: (id: FeatureWallSetupStepId) => void
  onOrchestrationSkillInstalledChange: (installed: boolean) => void
  onBrowserUseSkillInstalledChange: (installed: boolean) => void
}

function SetupStepRow(props: {
  step: FeatureWallSetupStep
  done: boolean
  active: boolean
  onSelect: () => void
}): React.JSX.Element {
  const { step, done, active, onSelect } = props
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={active ? 'step' : undefined}
      className={cn(
        'flex w-full items-center gap-3 rounded-md border px-3 py-2.5 text-left transition-colors',
        active
          ? 'border-border bg-accent text-accent-foreground'
          : 'border-border bg-card hover:bg-accent'
      )}
    >
      <span
        className={cn(
          'flex size-5 shrink-0 items-center justify-center rounded-full border',
          done
            ? 'border-green-500/45 bg-green-500/10 text-green-600 dark:text-green-300'
            : 'border-border text-muted-foreground'
        )}
      >
        {done ? <Check className="size-3" /> : null}
      </span>
      <span className="min-w-0">
        <span className="block text-[15px] font-medium leading-tight text-foreground">
          {step.name}
        </span>
      </span>
    </button>
  )
}

function SetupSection(props: {
  title: string
  steps: readonly FeatureWallSetupStep[]
  activeStepId: FeatureWallSetupStepId | null
  progress: FeatureWallSetupProgress
  onSelectStep: (id: FeatureWallSetupStepId) => void
}): React.JSX.Element {
  const doneCount = props.steps.filter((step) => props.progress.stepDone[step.id]).length
  return (
    <section className="space-y-2">
      <div className="flex items-center justify-between gap-3">
        <h4 className="text-xs font-semibold uppercase tracking-[0.08em] text-muted-foreground">
          {props.title}
        </h4>
        <span className="font-mono text-xs text-muted-foreground">
          {doneCount}/{props.steps.length}
        </span>
      </div>
      <div className="space-y-1.5">
        {props.steps.map((step) => (
          <SetupStepRow
            key={step.id}
            step={step}
            done={props.progress.stepDone[step.id]}
            active={props.activeStepId === step.id}
            onSelect={() => props.onSelectStep(step.id)}
          />
        ))}
      </div>
    </section>
  )
}

function SelectedStepAction(props: FeatureWallSetupChecklistProps): React.JSX.Element | null {
  const { activeStep } = props
  const reducedMotion = usePrefersReducedMotion()
  if (!activeStep) {
    return null
  }
  const activeDone = props.progress.stepDone[activeStep.id]
  if (activeStep.id === 'default-agent') {
    return <DefaultAgentAction />
  }
  if (activeStep.id === 'add-two-repos') {
    return <AddReposAction reducedMotion={reducedMotion} />
  }
  if (activeStep.id === 'notifications') {
    return <NotificationAction />
  }
  if (activeStep.id === 'split-terminal') {
    return <TwoAgentsAction reducedMotion={reducedMotion} done={activeDone} />
  }
  if (activeStep.id === 'two-worktrees') {
    return <WorkspacesAction reducedMotion={reducedMotion} done={activeDone} />
  }
  if (activeStep.id === 'task-sources') {
    return <TaskSourcesAction reducedMotion={reducedMotion} />
  }
  if (activeStep.id === 'agent-capabilities') {
    return (
      <AgentCapabilitiesSetupAction
        reducedMotion={reducedMotion}
        onOrchestrationSkillInstalledChange={props.onOrchestrationSkillInstalledChange}
        onBrowserUseSkillInstalledChange={props.onBrowserUseSkillInstalledChange}
      />
    )
  }
  if (activeStep.id === 'setup-script') {
    return <SetupScriptAction reducedMotion={reducedMotion} />
  }
  return null
}

function DefaultAgentAction(): React.JSX.Element {
  const settings = useAppStore((s) => s.settings)
  const updateSettings = useAppStore((s) => s.updateSettings)
  const refreshDetectedAgents = useAppStore((s) => s.refreshDetectedAgents)
  const detectedAgentIds = useAppStore((s) => s.detectedAgentIds)
  const isDetectingAgents = useAppStore((s) => s.isDetectingAgents || s.isRefreshingAgents)
  const selectedAgent =
    settings?.defaultTuiAgent && settings.defaultTuiAgent !== 'blank'
      ? settings.defaultTuiAgent
      : null
  const detectedSet = useMemo(() => new Set(detectedAgentIds ?? []), [detectedAgentIds])
  const handleSelectAgent = useCallback(
    (agent: TuiAgent) => {
      void updateSettings({ defaultTuiAgent: agent })
    },
    [updateSettings]
  )

  useEffect(() => {
    void refreshDetectedAgents()
  }, [refreshDetectedAgents])

  return (
    <div className="rounded-xl border border-border bg-muted/20 p-4">
      <AgentStep
        selectedAgent={selectedAgent}
        onSelect={handleSelectAgent}
        detectedSet={detectedSet}
        isDetecting={isDetectingAgents}
      />
    </div>
  )
}

function NotificationAction(): React.JSX.Element {
  const settings = useAppStore((s) => s.settings)
  const updateSettings = useAppStore((s) => s.updateSettings)
  return (
    <div className="rounded-xl border border-border bg-muted/20 p-4">
      <NotificationStep settings={settings} updateSettings={updateSettings} />
    </div>
  )
}

function TaskSourcesAction(props: { reducedMotion: boolean }): React.JSX.Element {
  const closeModal = useAppStore((s) => s.closeModal)
  const openTaskPage = useAppStore((s) => s.openTaskPage)
  return (
    <div className="space-y-5">
      <div className="grid gap-3 xl:grid-cols-2">
        <GitHubRow compact />
        <LinearRow compact />
      </div>
      <Button
        type="button"
        size="sm"
        className="w-fit gap-2"
        onClick={() => {
          closeModal()
          openTaskPage()
        }}
      >
        <ArrowUpRight className="size-3.5" />
        See tasks
      </Button>
      <SetupStepPreview className="mx-auto h-[220px] w-full max-w-[480px]">
        <TasksAnimatedVisual reducedMotion={props.reducedMotion} />
      </SetupStepPreview>
    </div>
  )
}

export function FeatureWallSetupChecklist(
  props: FeatureWallSetupChecklistProps
): React.JSX.Element {
  const { activeStep, progress, onSelectStep } = props
  const activeDone = activeStep ? progress.stepDone[activeStep.id] : false
  const parallelWorkSteps = getFeatureWallSetupStepsForSection('parallel-work')
  const setupSteps = getFeatureWallSetupStepsForSection('setup')

  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(280px,360px)_minmax(0,1fr)]">
      <div className="space-y-5">
        <SetupSection
          title="Start here"
          steps={parallelWorkSteps}
          activeStepId={activeStep?.id ?? null}
          progress={progress}
          onSelectStep={onSelectStep}
        />
        <SetupSection
          title="Setup"
          steps={setupSteps}
          activeStepId={activeStep?.id ?? null}
          progress={progress}
          onSelectStep={onSelectStep}
        />
      </div>

      <section className="min-h-[420px] rounded-xl border border-border bg-card p-5">
        {activeStep ? (
          <div className="flex h-full flex-col gap-4">
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0 space-y-1">
                <div className="text-2xl font-semibold leading-tight tracking-tight text-foreground">
                  {activeStep.name}
                </div>
                <p className="max-w-[58ch] text-base leading-normal text-muted-foreground">
                  {activeStep.description}
                </p>
              </div>
              <span
                className={cn(
                  'shrink-0 rounded-full border px-2.5 py-1 text-xs font-medium',
                  activeDone
                    ? 'border-green-500/45 bg-green-500/10 text-green-600 dark:text-green-300'
                    : 'border-border bg-muted/30 text-muted-foreground'
                )}
              >
                {activeDone ? 'Done' : 'Not done yet'}
              </span>
            </div>
            <SelectedStepAction {...props} />
          </div>
        ) : null}
      </section>
    </div>
  )
}
