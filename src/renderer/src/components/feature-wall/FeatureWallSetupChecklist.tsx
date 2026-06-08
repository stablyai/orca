import { useCallback, useEffect, useMemo } from 'react'
import { ArrowUpRight, Check } from 'lucide-react'
import type {
  FeatureWallSetupStep,
  FeatureWallSetupStepId
} from '../../../../shared/feature-wall-setup-steps'
import { getFeatureWallSetupStepsForSection } from '../../../../shared/feature-wall-setup-steps'
import { cn } from '@/lib/utils'
import type { FeatureWallSetupProgress } from './feature-wall-setup-progress'
import { AgentCapabilitiesSetupAction } from './AgentCapabilitiesSetupAction'
import {
  AddReposAction,
  SetupScriptAction,
  SplitTerminalShortcutHint,
  TwoAgentsAction,
  WorkspacesAction
} from './FeatureWallSetupWorkflowActions'
import {
  SetupMultipleReposVisual,
  SetupTwoAgentsVisual,
  SetupWorkspacesVisual
} from './FeatureWallSetupStepVisuals'
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
  ordinal: number
  onSelect: () => void
}): React.JSX.Element {
  const { step, done, active, ordinal, onSelect } = props
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={active ? 'step' : undefined}
      className={cn(
        'relative flex w-full items-center gap-3 rounded-md border px-3 py-2.5 text-left transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
        active
          ? 'border-border bg-accent text-accent-foreground'
          : 'border-border bg-background hover:bg-accent'
      )}
    >
      {active ? (
        <span className="absolute bottom-2 left-0 top-2 w-0.5 rounded-full bg-foreground" />
      ) : null}
      <span
        className={cn(
          'flex size-5 shrink-0 items-center justify-center rounded-full border',
          done
            ? 'border-green-500/45 bg-green-500/10 text-green-600 dark:text-green-300'
            : 'border-border text-muted-foreground'
        )}
      >
        {done ? <Check className="size-3" /> : <span className="text-xs">{ordinal}</span>}
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
  startOrdinal: number
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
        {props.steps.map((step, index) => (
          <SetupStepRow
            key={step.id}
            step={step}
            done={props.progress.stepDone[step.id]}
            active={props.activeStepId === step.id}
            ordinal={props.startOrdinal + index}
            onSelect={() => props.onSelectStep(step.id)}
          />
        ))}
      </div>
    </section>
  )
}

function SelectedStepAction(props: FeatureWallSetupChecklistProps): React.JSX.Element | null {
  const { activeStep } = props
  if (!activeStep) {
    return null
  }
  const activeDone = props.progress.stepDone[activeStep.id]
  if (activeStep.id === 'default-agent') {
    return <DefaultAgentAction />
  }
  if (activeStep.id === 'add-two-repos') {
    return <AddReposAction />
  }
  if (activeStep.id === 'notifications') {
    return <NotificationAction />
  }
  if (activeStep.id === 'split-terminal') {
    return <TwoAgentsAction done={activeDone} />
  }
  if (activeStep.id === 'two-worktrees') {
    return <WorkspacesAction done={activeDone} />
  }
  if (activeStep.id === 'task-sources') {
    return <TaskSourcesAction />
  }
  if (activeStep.id === 'agent-capabilities') {
    return (
      <AgentCapabilitiesSetupAction
        onOrchestrationSkillInstalledChange={props.onOrchestrationSkillInstalledChange}
        onBrowserUseSkillInstalledChange={props.onBrowserUseSkillInstalledChange}
      />
    )
  }
  if (activeStep.id === 'setup-script') {
    return <SetupScriptAction />
  }
  return null
}

function SelectedStepVisual(props: { stepId: FeatureWallSetupStepId }): React.JSX.Element | null {
  if (props.stepId === 'split-terminal') {
    return <SetupTwoAgentsVisual />
  }
  if (props.stepId === 'two-worktrees') {
    return <SetupWorkspacesVisual />
  }
  if (props.stepId === 'add-two-repos') {
    return <SetupMultipleReposVisual />
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
    <div className="max-w-3xl">
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
    <div className="max-w-3xl">
      <NotificationStep settings={settings} updateSettings={updateSettings} />
    </div>
  )
}

function TaskSourcesAction(): React.JSX.Element {
  const closeModal = useAppStore((s) => s.closeModal)
  const openTaskPage = useAppStore((s) => s.openTaskPage)
  return (
    <div className="space-y-5">
      <div className="grid gap-3 xl:grid-cols-2">
        <GitHubRow compact />
        <LinearRow compact />
      </div>
      <div className="flex items-center pt-2">
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
      </div>
    </div>
  )
}

export function FeatureWallSetupChecklist(
  props: FeatureWallSetupChecklistProps
): React.JSX.Element {
  const { activeStep, progress, onSelectStep } = props
  const activeDone = activeStep ? progress.stepDone[activeStep.id] : false
  // Only steps with a visual constrain the caption to a narrow column so the
  // illustration can sit beside it; captionless steps let the copy run full width.
  const hasStepVisual =
    activeStep?.id === 'split-terminal' ||
    activeStep?.id === 'two-worktrees' ||
    activeStep?.id === 'add-two-repos'
  const parallelWorkSteps = getFeatureWallSetupStepsForSection('parallel-work')
  const setupSteps = getFeatureWallSetupStepsForSection('setup')

  return (
    <div className="grid h-full min-h-0 grid-rows-[auto_minmax(0,1fr)] gap-5 lg:grid-cols-[minmax(200px,300px)_minmax(0,1fr)] lg:grid-rows-[minmax(0,1fr)]">
      <div className="scrollbar-sleek min-h-0 space-y-5 overflow-y-auto pr-1">
        <SetupSection
          title="Milestones"
          steps={parallelWorkSteps}
          startOrdinal={1}
          activeStepId={activeStep?.id ?? null}
          progress={progress}
          onSelectStep={onSelectStep}
        />
        <SetupSection
          title="Setup"
          steps={setupSteps}
          startOrdinal={parallelWorkSteps.length + 1}
          activeStepId={activeStep?.id ?? null}
          progress={progress}
          onSelectStep={onSelectStep}
        />
      </div>

      <section className="scrollbar-sleek min-h-0 overflow-y-auto border-t border-border pt-5 lg:border-l lg:border-t-0 lg:pl-7 lg:pt-0">
        {activeStep ? (
          <div className="flex h-full flex-col gap-5">
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <div className="text-2xl font-semibold leading-tight text-foreground">
                  {activeStep.name}
                </div>
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
            <div
              className={cn(
                'grid max-w-3xl items-start',
                hasStepVisual ? 'gap-8 sm:grid-cols-[minmax(0,48ch)_auto] sm:gap-10' : 'gap-5'
              )}
            >
              <div className="min-w-0">
                <p
                  className={cn(
                    'text-base leading-normal text-muted-foreground',
                    hasStepVisual ? 'pr-4 sm:pr-6' : null
                  )}
                >
                  {activeStep.description}
                </p>
                {activeStep.id === 'split-terminal' ? (
                  <div className="mt-3">
                    <SplitTerminalShortcutHint />
                  </div>
                ) : null}
                {/* Action lives under the caption, not after the grid, so it sits just
                    below the copy instead of being pushed down by the taller visual. */}
                <div className="mt-7 min-w-0">
                  <SelectedStepAction {...props} />
                </div>
              </div>
              <SelectedStepVisual stepId={activeStep.id} />
            </div>
          </div>
        ) : null}
      </section>
    </div>
  )
}
