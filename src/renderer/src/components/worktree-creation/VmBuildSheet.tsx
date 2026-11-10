import React from 'react'
import { AlertTriangle, Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useTranslate, type Translate } from '@/i18n/use-translate'
import { resolveVmEnvironmentCheckDecision } from '@/runtime/ephemeral-vm/ephemeral-vm-environment-check-decision'
import type { PendingWorktreeCreation } from '@/lib/workspace/creation/pending-worktree-creation'
import { toast } from 'sonner'
import type { EnvironmentSetupFailureContext } from '../../../../shared/environment-setup-agent-prompt'
import { formatEnvironmentDoctorChecks } from '../../../../shared/environment-doctor-types'
import { StepIcon } from './WorktreeSetupSteps'
import type { WorktreeSetupStepState } from './worktree-setup-steps'
import { VmBuildLog } from './VmBuildLog'
import { VmBuildFailureCard, type VmBuildFailure } from './VmBuildFailureCard'

type VmBuildStep = { id: 'provision' | 'checks' | 'create'; state: WorktreeSetupStepState }

/** Provision, then the VM's environment checks, then the workspace; a failed step keeps the steps before it done. */
export function deriveVmBuildSteps(
  entry: Pick<PendingWorktreeCreation, 'status' | 'environmentCheck'>
): VmBuildStep[] {
  const check = entry.environmentCheck?.status
  const failed = entry.status === 'error'
  return [
    { id: 'provision', state: check ? 'done' : failed ? 'failed' : 'running' },
    {
      id: 'checks',
      state: !check
        ? 'pending'
        : check === 'running'
          ? 'running'
          : check === 'failed'
            ? 'failed'
            : check === 'skipped'
              ? // An older VM server ran nothing, so the step must not read as verified.
                'pending'
              : 'done'
    },
    { id: 'create', state: 'pending' }
  ]
}

// Lazy: the agent-launch graph is heavy and only needed once the user asks for it.
function startFixWithAgent(args: {
  repoId: string
  recipeId: string
  failure: EnvironmentSetupFailureContext
}): void {
  void import('@/lib/agent-session/launch/environment-setup-agent-launch')
    .then(({ launchEnvironmentSetupAgent }) => launchEnvironmentSetupAgent(args))
    .catch((launchError: unknown) => {
      toast.error(launchError instanceof Error ? launchError.message : String(launchError))
    })
}

function stepLabel(step: VmBuildStep, t: Translate): string {
  switch (step.id) {
    case 'provision':
      return t('auto.components.worktree.creation.VmBuildSheet.provision', 'Provision VM')
    case 'checks':
      return t('auto.components.worktree.creation.VmBuildSheet.checks', 'Check environment')
    case 'create':
      return t('auto.components.worktree.creation.VmBuildSheet.create', 'Create workspace')
  }
}

/** The VM create sheet: a named-phase checklist, a failure card with recovery actions, and the recipe log. */
export function VmBuildSheet({
  creationId,
  entry,
  elapsedLabel,
  error,
  onCancel,
  onRetry,
  onDismiss,
  onEditRecipe
}: {
  creationId: string
  entry: PendingWorktreeCreation
  elapsedLabel: string
  error: string | null
  onCancel: () => void
  onRetry: () => void
  onDismiss: () => void
  onEditRecipe: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const steps = deriveVmBuildSteps(entry)
  const checkStatus = entry.environmentCheck?.status
  const checksFailed = checkStatus === 'failed'
  const recipe = entry.request.ephemeralVmRecipe
  const problems = (entry.environmentCheck?.checks ?? []).filter((check) => check.status !== 'pass')

  const fixWithAgent = (): void => {
    if (!recipe) {
      return
    }
    startFixWithAgent({
      repoId: recipe.sourceRepoId,
      recipeId: recipe.recipeId,
      failure: checksFailed
        ? {
            step: stepLabel(steps[1], t),
            error: problems
              .filter((check) => check.status === 'fail')
              .map((check) => check.message)
              .join(' '),
            log: formatEnvironmentDoctorChecks(problems).join('\n')
          }
        : {
            step: stepLabel(steps[0], t),
            error: error ?? '',
            log: entry.provisioningLog
          }
    })
  }

  const failure: VmBuildFailure | null = checksFailed
    ? { kind: 'checks', problems }
    : error !== null
      ? { kind: 'provision', error }
      : null
  const building = failure === null

  return (
    <div className="flex min-h-full justify-center pt-12">
      <div className="flex w-full max-w-2xl flex-col gap-4">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 text-sm font-medium text-foreground">
            <span className="grid size-4 shrink-0 place-items-center">
              {building ? (
                <Loader2 className="size-4 text-muted-foreground motion-safe:animate-spin" />
              ) : (
                <AlertTriangle className="size-4 text-destructive motion-safe:animate-in motion-safe:fade-in-0 motion-safe:zoom-in-90 motion-safe:duration-200" />
              )}
            </span>
            <span>
              {t('auto.components.worktree.creation.VmBuildSheet.title', 'Building your VM')}
            </span>
            <span className="text-xs font-normal tabular-nums text-muted-foreground">
              {elapsedLabel}
            </span>
          </div>
          {/* Reserve the slot so the header never shifts when Cancel gives way to the card's actions. */}
          <button
            type="button"
            onClick={onCancel}
            tabIndex={building ? undefined : -1}
            aria-hidden={!building}
            className={cn(
              'text-xs text-muted-foreground transition-opacity duration-150 hover:text-foreground hover:underline motion-reduce:transition-none',
              !building && 'pointer-events-none opacity-0'
            )}
          >
            {t(
              'auto.components.worktree.creation.WorktreeCreationPanel.cancelProvisioning',
              'Cancel'
            )}
          </button>
        </div>

        <div>
          <ol className="flex flex-col rounded-lg border border-border bg-card px-4 py-2 text-sm">
            {steps.map((step) => (
              <li key={step.id} className="flex items-center gap-2.5 py-1.5">
                <StepIcon state={step.state} />
                <span
                  className={cn(
                    'min-w-0 flex-1 truncate transition-colors duration-200 motion-reduce:transition-none',
                    step.state === 'pending' && 'text-muted-foreground',
                    step.state === 'failed' && 'text-destructive'
                  )}
                >
                  {stepLabel(step, t)}
                </span>
              </li>
            ))}
          </ol>

          <VmBuildFailureCard
            failure={failure}
            canFixWithAgent={Boolean(recipe)}
            onFixWithAgent={fixWithAgent}
            onRetry={
              checksFailed ? () => resolveVmEnvironmentCheckDecision(creationId, 'retry') : onRetry
            }
            onEditRecipe={onEditRecipe}
            onOpenAnyway={() => resolveVmEnvironmentCheckDecision(creationId, 'open-anyway')}
            onDismiss={onDismiss}
          />
        </div>

        <VmBuildLog
          log={entry.provisioningLog ?? ''}
          emptyLabel={t(
            'auto.components.worktree.creation.WorktreeCreationPanel.vmProvisioningLogEmpty',
            'Waiting for recipe output…'
          )}
        />
      </div>
    </div>
  )
}
