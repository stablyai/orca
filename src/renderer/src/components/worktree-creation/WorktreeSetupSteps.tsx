import React from 'react'
import { Circle, CircleCheck, CircleX, Loader2, RotateCcw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import { formatElapsedTime } from './worktree-creation-clock'
import type { WorktreeSetupStep, WorktreeSetupStepId } from './worktree-setup-steps'

function stepLabel(id: WorktreeSetupStepId, agentLabel: string): string {
  switch (id) {
    case 'prepare':
      return translate(
        'auto.components.worktree.creation.WorktreeSetupSteps.prepare',
        'Prepare workspace'
      )
    case 'fetch':
      return translate(
        'auto.components.worktree.creation.WorktreeSetupSteps.fetch',
        'Fetch base branch'
      )
    case 'create':
      return translate(
        'auto.components.worktree.creation.WorktreeSetupSteps.create',
        'Create worktree'
      )
    case 'setup':
      return translate(
        'auto.components.worktree.creation.WorktreeSetupSteps.setup',
        'Set up workspace'
      )
    case 'start-agent':
      return translate(
        'auto.components.worktree.creation.WorktreeSetupSteps.startAgent',
        'Start {{agent}}',
        { agent: agentLabel }
      )
  }
}

function StepIcon({ state }: { state: WorktreeSetupStep['state'] }): React.JSX.Element {
  switch (state) {
    case 'running':
      return (
        <Loader2 aria-hidden className="size-3.5 shrink-0 animate-spin text-muted-foreground" />
      )
    case 'done':
      return <CircleCheck aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
    case 'failed':
      return <CircleX aria-hidden className="size-3.5 shrink-0 text-destructive" />
    case 'pending':
      return <Circle aria-hidden className="size-3.5 shrink-0 text-muted-foreground/60" />
  }
}

/** The worktree's setup checklist under a pending chat's first message, with Retry/Dismiss once it fails. */
export function WorktreeSetupSteps({
  steps,
  agentLabel,
  error,
  onRetry,
  onDismiss
}: {
  steps: readonly WorktreeSetupStep[]
  agentLabel: string
  /** Set once creation failed; the card then says why and offers Retry. */
  error: string | null
  onRetry: () => void
  onDismiss: () => void
}): React.JSX.Element {
  const progressId = React.useId()
  return (
    <div className="w-full rounded-lg border border-border bg-card px-3 py-2 text-sm text-foreground">
      <ol className="flex flex-col">
        {steps.map((step) => (
          <li key={step.id} className="flex flex-col gap-1 py-1">
            <div className="flex items-center gap-2">
              <StepIcon state={step.state} />
              <span
                id={step.percent !== null ? progressId : undefined}
                className={cn(
                  'min-w-0 flex-1 truncate',
                  step.state === 'pending' && 'text-muted-foreground',
                  step.state === 'failed' && 'text-destructive'
                )}
              >
                {stepLabel(step.id, agentLabel)}
              </span>
              {step.percent !== null ? (
                <span className="text-xs tabular-nums text-muted-foreground">{step.percent}%</span>
              ) : null}
              {step.elapsedMs !== null ? (
                <span className="w-12 text-right text-xs tabular-nums text-muted-foreground">
                  {formatElapsedTime(step.elapsedMs)}
                </span>
              ) : null}
            </div>
            {step.percent !== null ? (
              <Progress
                value={step.percent}
                aria-labelledby={progressId}
                className="ml-5.5 h-1 w-auto"
              />
            ) : null}
          </li>
        ))}
      </ol>
      {error !== null ? (
        <div className="mt-1 flex flex-col gap-2 border-t border-border pt-2">
          <p className="break-words text-xs text-muted-foreground">{error}</p>
          <div className="flex items-center gap-1.5">
            <Button type="button" variant="outline" size="xs" onClick={onRetry}>
              <RotateCcw />
              {translate(
                'auto.components.worktree.creation.WorktreeCreationPanel.34dd5ee38b',
                'Retry'
              )}
            </Button>
            <Button type="button" variant="ghost" size="xs" onClick={onDismiss}>
              {translate(
                'auto.components.worktree.creation.WorktreeCreationPanel.dabd226118',
                'Dismiss'
              )}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  )
}
