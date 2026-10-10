import { useCallback, useEffect, useMemo } from 'react'
import { Check } from 'lucide-react'
import type {
  FeatureWallSetupStep,
  FeatureWallSetupStepId
} from '../../../../shared/feature-wall-setup-steps'
import { getFeatureWallSetupStepsForSection } from '../../../../shared/feature-wall-setup-steps'
import { cn } from '@/lib/utils'
import type { FeatureWallSetupProgress } from './feature-wall-setup-progress'
import { FullDiskAccessSetupPrompt } from './FullDiskAccessSetupPrompt'
import { AgentCapabilitiesSetupAction } from './AgentCapabilitiesSetupAction'
import {
  AddReposAction,
  SetupScriptAction,
  WorkspacesAction
} from './FeatureWallSetupWorkflowActions'
import { ConnectIntegrationsList } from './ConnectIntegrationsList'
import { BrowserAction } from './FeatureWallBrowserAction'
import {
  SetupBrowserVisual,
  SetupMultipleReposVisual,
  SetupWorkspacesVisual
} from './FeatureWallSetupStepVisuals'
import { AgentStep } from '../onboarding/AgentStep'
import { NotificationStep } from '../onboarding/NotificationStep'
import { useAppStore } from '@/store'
import type { TuiAgent } from '../../../../shared/tui-agent'
import { getProviderRuntimeContextKey } from '@/lib/provider-runtime-context'
import { translate } from '@/i18n/i18n'

import { getLocalizedFeatureWallSetupChecklistCopy } from './feature-wall-setup-checklist-localized-copy'

type FeatureWallSetupChecklistLayout = 'modal' | 'embedded'

type FeatureWallSetupChecklistProps = {
  activeStep: FeatureWallSetupStep | null
  progress: FeatureWallSetupProgress
  onSelectStep: (id: FeatureWallSetupStepId) => void
  onOrchestrationSkillInstalledChange: (installed: boolean) => void
  onBrowserUseSkillInstalledChange: (installed: boolean) => void
  /** Modal keeps a compact rail; embedded (settings pane) gets more column breathing room. */
  layout?: FeatureWallSetupChecklistLayout
}

function SetupStepRow(props: {
  step: FeatureWallSetupStep
  done: boolean
  active: boolean
  ordinal: number
  onSelect: () => void
}): React.JSX.Element {
  const { step, done, active, ordinal, onSelect } = props
  const localizedStepCopy = getLocalizedFeatureWallSetupChecklistCopy(step)
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={active ? 'step' : undefined}
      className={cn(
        'flex w-full items-center gap-3 rounded-md px-2.5 py-2 text-left transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        active ? 'bg-accent' : 'hover:bg-accent/60'
      )}
    >
      <span
        className={cn(
          'flex size-5 shrink-0 items-center justify-center rounded-full border',
          done
            ? 'border-foreground bg-foreground text-background'
            : 'border-border text-muted-foreground'
        )}
      >
        {done ? (
          <Check className="size-3" strokeWidth={3} />
        ) : (
          <span className="text-[11px] tabular-nums">{ordinal}</span>
        )}
      </span>
      <span
        className={cn(
          'min-w-0 flex-1 text-sm leading-snug',
          active
            ? 'font-medium text-foreground'
            : done
              ? 'text-muted-foreground'
              : 'text-foreground'
        )}
      >
        {localizedStepCopy.name}
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
        <h4 className="text-[11px] font-semibold uppercase tracking-[0.05em] text-muted-foreground">
          {props.title}
        </h4>
        <span className="text-[11px] tabular-nums text-muted-foreground">
          {doneCount}/{props.steps.length}
        </span>
      </div>
      <div className="space-y-0.5">
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
  if (activeStep.id === 'two-worktrees') {
    return <WorkspacesAction done={activeDone} />
  }
  if (activeStep.id === 'browser') {
    return <BrowserAction done={activeDone} />
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

// Full-width content below the caption/visual grid.
function SelectedStepFooter(props: { stepId: FeatureWallSetupStepId }): React.JSX.Element | null {
  // Why: Full Disk Access matters for projects in protected folders, so it sits with adding projects.
  if (props.stepId === 'add-two-repos') {
    return <FullDiskAccessSetupPrompt />
  }
  return null
}

function SelectedStepVisual(props: { stepId: FeatureWallSetupStepId }): React.JSX.Element | null {
  if (props.stepId === 'two-worktrees') {
    return <SetupWorkspacesVisual />
  }
  if (props.stepId === 'add-two-repos') {
    return <SetupMultipleReposVisual />
  }
  if (props.stepId === 'browser') {
    return <SetupBrowserVisual />
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
  const refreshPreflightStatus = useAppStore((s) => s.refreshPreflightStatus)
  const checkJiraConnection = useAppStore((s) => s.checkJiraConnection)
  const checkLinearConnection = useAppStore((s) => s.checkLinearConnection)
  const settings = useAppStore((s) => s.settings)
  const providerRuntimeContextKey = getProviderRuntimeContextKey(settings)

  useEffect(() => {
    void refreshPreflightStatus()
    void checkJiraConnection()
    void checkLinearConnection()
  }, [
    refreshPreflightStatus,
    checkJiraConnection,
    checkLinearConnection,
    providerRuntimeContextKey
  ])

  return (
    <div className="space-y-5">
      <ConnectIntegrationsList />
    </div>
  )
}

export function FeatureWallSetupChecklist(
  props: FeatureWallSetupChecklistProps
): React.JSX.Element {
  const { activeStep, progress, onSelectStep, layout = 'modal' } = props
  const isEmbedded = layout === 'embedded'
  const activeDone = activeStep ? progress.stepDone[activeStep.id] : false
  // Only steps with a visual constrain the caption to a narrow column so the
  // illustration can sit beside it; captionless steps let the copy run full width.
  const hasStepVisual =
    activeStep?.id === 'two-worktrees' ||
    activeStep?.id === 'browser' ||
    activeStep?.id === 'add-two-repos'
  const setupSteps = getFeatureWallSetupStepsForSection('setup')
  const parallelWorkSteps = getFeatureWallSetupStepsForSection('parallel-work')
  const visualBreakpoint = isEmbedded ? 'xl' : 'sm'
  const visualGridClass =
    visualBreakpoint === 'xl'
      ? 'gap-8 xl:grid-cols-[minmax(0,1fr)_auto] xl:gap-12'
      : 'gap-8 sm:grid-cols-[minmax(0,48ch)_auto] sm:gap-10'

  // Why: in the modal, a stacked checklist can leave medium-width windows with
  // only a tiny action pane; switch to the rail/content layout sooner.
  return (
    <div
      className={cn(
        'grid h-full min-h-0',
        isEmbedded
          ? 'grid-rows-[auto_minmax(0,1fr)] gap-10 lg:grid-cols-[minmax(15rem,17rem)_minmax(0,1fr)] lg:grid-rows-[minmax(0,1fr)] lg:gap-16'
          : 'grid-rows-[auto_minmax(0,1fr)] gap-5 md:grid-cols-[minmax(190px,260px)_minmax(0,1fr)] md:grid-rows-[minmax(0,1fr)]'
      )}
    >
      <div
        className={cn(
          'scrollbar-sleek min-h-0 space-y-5 overflow-y-auto',
          isEmbedded ? 'pr-4' : 'max-h-[min(18rem,40vh)] pr-1 md:max-h-none'
        )}
      >
        <SetupSection
          title={translate(
            'auto.components.feature.wall.FeatureWallSetupChecklist.1a6a7d6c80',
            'Setup'
          )}
          steps={setupSteps}
          startOrdinal={1}
          activeStepId={activeStep?.id ?? null}
          progress={progress}
          onSelectStep={onSelectStep}
        />
        <SetupSection
          title={translate(
            'auto.components.feature.wall.FeatureWallSetupChecklist.713cc529a5',
            'Milestones'
          )}
          steps={parallelWorkSteps}
          startOrdinal={setupSteps.length + 1}
          activeStepId={activeStep?.id ?? null}
          progress={progress}
          onSelectStep={onSelectStep}
        />
      </div>

      <section
        className={cn(
          'scrollbar-sleek min-h-0 overflow-y-auto',
          isEmbedded
            ? 'pt-10 lg:border-l lg:border-border/50 lg:pl-14 lg:pt-0'
            : 'border-t border-border pt-5 md:border-l md:border-t-0 md:pl-7 md:pt-0'
        )}
      >
        {activeStep ? (
          <div className={cn('flex h-full flex-col', isEmbedded ? 'gap-4' : 'gap-3')}>
            <div className="flex items-center justify-between gap-4">
              <h3 className="min-w-0 text-xl font-semibold tracking-tight text-foreground">
                {getLocalizedFeatureWallSetupChecklistCopy(activeStep).name}
              </h3>
              {/* Why: a "not done" pill on every open step is noise; only completion is news. */}
              {activeDone ? (
                <span className="flex shrink-0 items-center gap-1.5 text-xs font-medium text-muted-foreground">
                  <Check className="size-3.5" />
                  {translate(
                    'auto.components.feature.wall.FeatureWallSetupChecklist.13294d3405',
                    'Done'
                  )}
                </span>
              ) : null}
            </div>
            <div
              className={cn(
                'grid items-start',
                hasStepVisual ? visualGridClass : 'max-w-3xl gap-5',
                !hasStepVisual && isEmbedded ? 'max-w-none' : null
              )}
            >
              <div className="min-w-0">
                <p
                  className={cn(
                    'text-sm leading-relaxed text-muted-foreground',
                    hasStepVisual && !isEmbedded ? 'pr-4 sm:pr-6' : null
                  )}
                >
                  {getLocalizedFeatureWallSetupChecklistCopy(activeStep).description}
                </p>
                {/* Action lives under the caption, not after the grid, so it sits just
                    below the copy instead of being pushed down by the taller visual. */}
                <div className={cn('min-w-0', isEmbedded ? 'mt-7' : 'mt-6')}>
                  <SelectedStepAction {...props} />
                </div>
              </div>
              <SelectedStepVisual stepId={activeStep.id} />
            </div>
            <SelectedStepFooter stepId={activeStep.id} />
          </div>
        ) : null}
      </section>
    </div>
  )
}
