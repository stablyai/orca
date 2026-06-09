import type { JSX, KeyboardEvent } from 'react'
import { Check } from 'lucide-react'
import {
  FEATURE_WALL_WORKFLOWS,
  type FeatureWallWorkflow,
  type FeatureWallWorkflowId
} from '../../../../shared/feature-wall-workflows'
import type { AgentsStep, AgentsStepId } from '../../../../shared/agents-orchestration-steps'
import type { WorkbenchStep, WorkbenchStepId } from '../../../../shared/workbench-steps'
import type { ReviewStep, ReviewStepId } from '../../../../shared/review-steps'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'

const SUB_STEP_LABELS = ['a', 'b', 'c', 'd', 'e', 'f'] as const

export function FeatureWallRail(props: {
  selectedId: FeatureWallWorkflowId
  previewPanelId: string
  railRefs: React.MutableRefObject<(HTMLButtonElement | null)[]>
  onSelect: (workflow: FeatureWallWorkflow) => void
  onRailKeyDown: (event: KeyboardEvent<HTMLButtonElement>, index: number) => void
  workflowDone: Record<FeatureWallWorkflowId, boolean>
  agentsSteps: readonly AgentsStep[]
  agentsActiveStepId: AgentsStepId | null
  agentStepDone: Record<AgentsStepId, boolean>
  onSelectAgentsStep: (id: AgentsStepId) => void
  workbenchSteps: readonly WorkbenchStep[]
  workbenchActiveStepId: WorkbenchStepId | null
  workbenchStepDone: Record<WorkbenchStepId, boolean>
  onSelectWorkbenchStep: (id: WorkbenchStepId) => void
  reviewSteps: readonly ReviewStep[]
  reviewActiveStepId: ReviewStepId | null
  reviewStepDone: Record<ReviewStepId, boolean>
  onSelectReviewStep: (id: ReviewStepId) => void
}): JSX.Element {
  const {
    selectedId,
    previewPanelId,
    railRefs,
    onSelect,
    onRailKeyDown,
    workflowDone,
    agentsSteps,
    agentsActiveStepId,
    agentStepDone,
    onSelectAgentsStep,
    workbenchSteps,
    workbenchActiveStepId,
    workbenchStepDone,
    onSelectWorkbenchStep,
    reviewSteps,
    reviewActiveStepId,
    reviewStepDone,
    onSelectReviewStep
  } = props
  return (
    <nav
      className="scrollbar-sleek h-full max-h-72 overflow-y-auto border-b border-border bg-card p-2 md:max-h-none md:border-b-0"
      aria-label={translate("auto.components.feature.wall.FeatureWallRail.7593d15f94", "Workflows")}
    >
      <div role="tablist" aria-orientation="vertical" className="flex flex-col gap-1.5 pt-1.5">
        {FEATURE_WALL_WORKFLOWS.map((workflow, index) => {
          const isSelected = workflow.id === selectedId
          const isDone = workflowDone[workflow.id] === true
          const subSteps =
            workflow.id === 'agents-orchestration'
              ? {
                  steps: agentsSteps,
                  activeId: agentsActiveStepId as string | null,
                  done: agentStepDone as Record<string, boolean>,
                  onSelect: (id: string) => onSelectAgentsStep(id as AgentsStepId)
                }
              : workflow.id === 'workbench'
                ? {
                    steps: workbenchSteps,
                    activeId: workbenchActiveStepId as string | null,
                    done: workbenchStepDone as Record<string, boolean>,
                    onSelect: (id: string) => onSelectWorkbenchStep(id as WorkbenchStepId)
                  }
                : workflow.id === 'review'
                  ? {
                      steps: reviewSteps,
                      activeId: reviewActiveStepId as string | null,
                      done: reviewStepDone as Record<string, boolean>,
                      onSelect: (id: string) => onSelectReviewStep(id as ReviewStepId)
                    }
                  : null
          const showSubSteps = subSteps !== null && isSelected
          return (
            <div key={workflow.id}>
              <button
                ref={(node) => {
                  railRefs.current[index] = node
                }}
                type="button"
                role="tab"
                aria-selected={isSelected}
                aria-controls={previewPanelId}
                tabIndex={isSelected ? 0 : -1}
                data-feature-wall-workflow-id={workflow.id}
                onClick={() => onSelect(workflow)}
                onKeyDown={(event) => onRailKeyDown(event, index)}
                className={cn(
                  'flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-sm outline-none transition-colors',
                  'hover:bg-accent',
                  'focus-visible:ring-[3px] focus-visible:ring-ring/50',
                  isSelected && 'bg-accent text-accent-foreground'
                )}
              >
                <span
                  className={cn(
                    'flex size-7 shrink-0 items-center justify-center rounded-sm border font-mono text-xs',
                    isDone
                      ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-300'
                      : 'border-border bg-card text-muted-foreground'
                  )}
                  aria-label={isDone ? translate("auto.components.feature.wall.FeatureWallRail.69ea857689", "Completed") : undefined}
                >
                  {isDone ? <Check className="size-3.5" aria-hidden /> : index + 1}
                </span>
                <span className="min-w-0 truncate font-medium leading-tight">{workflow.title}</span>
              </button>
              {subSteps ? (
                <div
                  aria-hidden={!showSubSteps}
                  className={cn(
                    'grid overflow-hidden transition-[grid-template-rows,opacity] duration-200 ease-out',
                    showSubSteps ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0'
                  )}
                >
                  <div className="min-h-0">
                    <div className="mt-1 flex flex-col gap-1 pl-7">
                      {subSteps.steps.map((step, stepIdx) => {
                        const isStepActive = step.id === subSteps.activeId
                        const isStepDone = subSteps.done[step.id] === true
                        const label = SUB_STEP_LABELS[stepIdx] ?? String(stepIdx + 1)
                        return (
                          <button
                            key={step.id}
                            type="button"
                            tabIndex={showSubSteps ? 0 : -1}
                            onClick={() => subSteps.onSelect(step.id)}
                            aria-current={isStepActive ? 'step' : undefined}
                            className={cn(
                              'flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[13px] outline-none transition-colors',
                              'hover:bg-accent',
                              'focus-visible:ring-[3px] focus-visible:ring-ring/50',
                              isStepActive && 'bg-accent text-accent-foreground'
                            )}
                          >
                            <span
                              className={cn(
                                'flex size-5 shrink-0 items-center justify-center rounded-sm border font-mono text-[10px]',
                                isStepDone
                                  ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-300'
                                  : 'border-border bg-card text-muted-foreground'
                              )}
                              aria-label={isStepDone ? translate("auto.components.feature.wall.FeatureWallRail.69ea857689", "Completed") : undefined}
                            >
                              {isStepDone ? <Check className="size-3" aria-hidden /> : `${label}.`}
                            </span>
                            <span
                              className={cn(
                                'truncate leading-tight',
                                isStepActive ? 'font-medium' : 'text-muted-foreground'
                              )}
                            >
                              {step.name}
                            </span>
                          </button>
                        )
                      })}
                    </div>
                  </div>
                </div>
              ) : null}
            </div>
          )
        })}
      </div>
    </nav>
  )
}
