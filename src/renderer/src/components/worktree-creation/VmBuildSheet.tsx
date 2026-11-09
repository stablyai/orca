import React from 'react'
import { AlertTriangle, ChevronRight, CircleAlert, CircleCheck, Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useAppStore } from '@/store'
import { useTranslate, type Translate } from '@/i18n/use-translate'
import { Progress } from '@/components/ui/progress'
import { resolveVmEnvironmentCheckDecision } from '@/lib/ephemeral-vm-environment-check-decision'
import { openPlansPage } from '@/components/billing/plans/plans-page-store'
import type { PendingWorktreeCreation } from '@/lib/workspace/creation/pending-worktree-creation'
import { toast } from 'sonner'
import type { EnvironmentSetupFailureContext } from '../../../../shared/environment-setup-agent-prompt'
import { formatEnvironmentDoctorChecks } from '../../../../shared/environment-doctor-types'
import { StepIcon } from './WorktreeSetupSteps'
import { firstBuildLogErrorLine, VmBuildLog } from './VmBuildLog'
import { VmBuildFailureCard } from './VmBuildFailureCard'
import { VmBuildAgentSignInRow } from './VmBuildAgentSignInRow'
import { VmBuildCloudAgentStep } from '../cloud-agent-setup/VmBuildCloudAgentStep'
import { OrcaCloudQueuedPrompt } from '@/components/orca-cloud/OrcaCloudQueuedPrompt'
import { classifyVmBuildFailure, isAccountGate, type VmBuildFailure } from './vm-build-failure'
import {
  deriveVmBuildSteps,
  isOrcaCloudBuild,
  ORCA_CLOUD_TYPICAL_STEP_SECONDS,
  type VmBuildStep
} from './vm-build-steps'
import { useMinimumRunningSteps } from './use-minimum-running-steps'
import { formatElapsedTime } from './worktree-creation-clock'
import { headerTitle, stepLabel, stepStateLabel, type SheetState } from './vm-build-sheet-copy'
import { humanizeOrcaCloudLogLine, latestOrcaCloudPhaseLabel } from './orca-cloud-build-log'

// Lazy: the agent-launch graph is heavy and only needed once the user asks for it.
function startFixWithAgent(args: {
  repoId: string
  recipeId: string
  failure: EnvironmentSetupFailureContext
}): void {
  void import('@/lib/environment-setup-agent-launch')
    .then(({ launchEnvironmentSetupAgent }) => launchEnvironmentSetupAgent(args))
    .catch((launchError: unknown) => {
      toast.error(launchError instanceof Error ? launchError.message : String(launchError))
    })
}

function fixContext(
  failure: VmBuildFailure | null,
  steps: readonly VmBuildStep[],
  entry: PendingWorktreeCreation,
  error: string | null,
  cloud: boolean,
  t: Translate
): EnvironmentSetupFailureContext {
  if (failure?.kind === 'checks') {
    return {
      step: stepLabel(steps[1], cloud, t),
      error: failure.problems
        .filter((check) => check.status === 'fail')
        .map((check) => check.message)
        .join(' '),
      log: formatEnvironmentDoctorChecks(failure.problems).join('\n')
    }
  }
  return { step: stepLabel(steps[0], cloud, t), error: error ?? '', log: entry.provisioningLog }
}

/** The VM create sheet: a timed checklist, a failure card with one clear way forward, and the build log. */
export function VmBuildSheet({
  creationId,
  entry,
  now,
  elapsedLabel,
  error,
  onCancel,
  onRetry,
  onDismiss,
  onEditRecipe,
  agentSignInRow,
  cloudAgentStep
}: {
  creationId: string
  entry: PendingWorktreeCreation
  now: number
  elapsedLabel: string
  error: string | null
  onCancel: () => void
  onRetry: () => void
  onDismiss: () => void
  onEditRecipe: () => void
  /** Fixtures only: a fixed sign-in row in place of the live one. */
  agentSignInRow?: React.ReactNode
  /** Fixtures only: a fixed "Add an agent" step in place of the live one. */
  cloudAgentStep?: React.ReactNode
}): React.JSX.Element {
  const t = useTranslate()
  const logId = React.useId()
  const firstErrorLine = React.useMemo(
    () => firstBuildLogErrorLine(entry.provisioningLog ?? ''),
    [entry.provisioningLog]
  )
  const cloud = isOrcaCloudBuild(entry)
  const formatLine = React.useMemo(
    () => (cloud ? (line: string) => humanizeOrcaCloudLogLine(line, t) : undefined),
    [cloud, t]
  )
  const [logOpen, setLogOpen] = React.useState(!cloud)
  const signingIn = useAppStore((state) => Boolean(state.orcaProfileSignInProgress))
  const recipe = entry.request.ephemeralVmRecipe
  const failure = classifyVmBuildFailure({ entry, error, cloud })
  const gated = isAccountGate(failure)
  const derived = deriveVmBuildSteps(entry, now).map((step) =>
    // Nothing started, so no step failed.
    (gated || failure?.kind === 'network') && step.state === 'failed'
      ? { ...step, state: 'pending' as const }
      : step
  )
  const steps = useMinimumRunningSteps(derived, failure === null, now)
  const state: SheetState = failure
    ? failure.kind === 'checks'
      ? 'attention'
      : 'failed'
    : steps.at(-1)?.state === 'done'
      ? 'ready'
      : 'building'
  const building = state === 'building'

  const signIn = (): void => {
    void useAppStore
      .getState()
      .connectCurrentOrcaProfile()
      .then((result) => {
        if (result?.status === 'connected') {
          onRetry()
        }
      })
      .catch((signInError: unknown) => {
        toast.error(signInError instanceof Error ? signInError.message : String(signInError))
      })
  }

  return (
    <div data-vm-build-sheet className="flex min-h-full justify-center pt-12">
      <div className="flex w-full max-w-2xl flex-col gap-4">
        <div className="flex items-center justify-between gap-3">
          <h2 className="flex items-center gap-2 text-sm font-medium text-foreground">
            <span className="grid size-4 shrink-0 place-items-center">
              {building ? (
                <Loader2
                  aria-hidden
                  className="size-4 text-muted-foreground motion-safe:animate-spin"
                />
              ) : state === 'ready' ? (
                <CircleCheck aria-hidden className="size-4 text-muted-foreground" />
              ) : gated ? (
                <CircleAlert aria-hidden className="size-4 text-muted-foreground" />
              ) : (
                <AlertTriangle
                  aria-hidden
                  className="size-4 text-destructive motion-safe:animate-in motion-safe:fade-in-0 motion-safe:zoom-in-90 motion-safe:duration-200"
                />
              )}
            </span>
            {/* The failure card announces failures itself. */}
            <span aria-live={failure ? 'off' : 'polite'}>
              {headerTitle(state, cloud, t, failure?.kind === 'create')}
            </span>
            <span className="text-xs font-normal tabular-nums text-muted-foreground">
              {elapsedLabel}
            </span>
          </h2>
          {/* Reserve the slot so the header never shifts when Cancel gives way to the card's actions. */}
          <button
            type="button"
            onClick={onCancel}
            tabIndex={building ? undefined : -1}
            aria-hidden={!building}
            className={cn(
              'rounded-sm text-xs text-muted-foreground transition-opacity duration-150 hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none',
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
              <StepRow
                key={step.id}
                step={step}
                cloud={cloud}
                detail={
                  cloud && step.id === 'provision' && step.state === 'running'
                    ? latestOrcaCloudPhaseLabel(entry.provisioningLog ?? '', t)
                    : null
                }
                t={t}
              />
            ))}
            {cloudAgentStep ?? <VmBuildCloudAgentStep creationId={creationId} entry={entry} />}
            {agentSignInRow ??
              (entry.vmEnvironmentId ? (
                <VmBuildAgentSignInRow
                  creationId={creationId}
                  environmentId={entry.vmEnvironmentId}
                />
              ) : null)}
          </ol>

          <VmBuildFailureCard
            failure={failure}
            cloud={cloud}
            vmKept={failure?.kind === 'checks' || Boolean(entry.request.ephemeralVmRuntimeId)}
            firstErrorLine={firstErrorLine}
            canFixWithAgent={Boolean(recipe)}
            signingIn={signingIn}
            actions={{
              onFixWithAgent: () => {
                if (recipe) {
                  startFixWithAgent({
                    repoId: recipe.sourceRepoId,
                    recipeId: recipe.recipeId,
                    failure: fixContext(failure, derived, entry, error, cloud, t)
                  })
                }
              },
              onRetry:
                failure?.kind === 'checks'
                  ? () => resolveVmEnvironmentCheckDecision(creationId, 'retry')
                  : onRetry,
              onEditRecipe,
              onOpenAnyway: () => resolveVmEnvironmentCheckDecision(creationId, 'open-anyway'),
              onDismiss,
              onSeePlans: () => openPlansPage('sandbox'),
              onOpenBilling: () => {
                const store = useAppStore.getState()
                store.openSettingsTarget({ pane: 'orca-account', repoId: null })
                store.openSettingsPage()
              },
              onSignIn: signIn
            }}
          />
        </div>

        {building ? <OrcaCloudQueuedPrompt creationId={creationId} /> : null}

        {cloud ? (
          <button
            type="button"
            aria-expanded={logOpen}
            aria-controls={logId}
            onClick={() => setLogOpen(!logOpen)}
            className="flex items-center gap-1 self-start rounded-sm text-xs text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <ChevronRight
              aria-hidden
              className={cn(
                'size-3.5 transition-transform duration-150 motion-reduce:transition-none',
                logOpen && 'rotate-90'
              )}
            />
            {logOpen
              ? t('auto.components.worktree.creation.VmBuildSheet.hideLogs', 'Hide logs')
              : t('auto.components.worktree.creation.VmBuildSheet.viewLogs', 'View logs')}
          </button>
        ) : null}
        {logOpen ? (
          <VmBuildLog
            id={logId}
            log={entry.provisioningLog ?? ''}
            stamps={entry.provisioningLogStamps ?? []}
            startedAt={entry.startedAt}
            emptyLabel={t(
              'auto.components.worktree.creation.VmBuildSheet.logEmpty',
              'Waiting for output…'
            )}
            formatLine={formatLine}
          />
        ) : null}
      </div>
    </div>
  )
}

function StepRow({
  step,
  cloud,
  detail,
  t
}: {
  step: VmBuildStep
  cloud: boolean
  /** What the running step is doing right now, in plain words. */
  detail: string | null
  t: Translate
}): React.JSX.Element {
  const labelId = React.useId()
  const typical =
    cloud && step.state === 'running' ? ORCA_CLOUD_TYPICAL_STEP_SECONDS[step.id] : null
  const slow = typical !== null && step.elapsedMs !== null && step.elapsedMs > typical * 2000

  return (
    <li
      className="flex flex-col gap-1 py-1.5"
      aria-current={step.state === 'running' ? 'step' : undefined}
    >
      <div className="flex items-center gap-2.5">
        <StepIcon state={step.state} />
        <span
          id={labelId}
          className={cn(
            'min-w-0 flex-1 truncate transition-colors duration-200 motion-reduce:transition-none',
            step.state === 'pending' && 'text-muted-foreground',
            step.state === 'failed' && 'text-destructive'
          )}
        >
          {stepLabel(step, cloud, t)}
        </span>
        <span className="sr-only">{stepStateLabel(step.state, t)}</span>
        {typical !== null ? (
          <span className="text-xs text-muted-foreground/70">
            {slow
              ? t('auto.components.worktree.creation.VmBuildSheet.slow', 'Taking longer than usual')
              : t(
                  'auto.components.worktree.creation.VmBuildSheet.usually',
                  'usually ~{{seconds}}s',
                  { seconds: typical }
                )}
          </span>
        ) : null}
        {step.percent !== null ? (
          <span className="w-9 text-right text-xs tabular-nums text-muted-foreground">
            {step.percent}%
          </span>
        ) : null}
        {step.elapsedMs !== null && step.state !== 'pending' ? (
          <span className="w-12 text-right text-xs tabular-nums text-muted-foreground">
            {formatElapsedTime(step.elapsedMs)}
          </span>
        ) : null}
      </div>
      {detail ? <p className="ml-6 text-xs text-muted-foreground">{detail}</p> : null}
      {step.percent !== null ? (
        <Progress value={step.percent} aria-labelledby={labelId} className="ml-6 h-1 w-auto" />
      ) : null}
    </li>
  )
}
