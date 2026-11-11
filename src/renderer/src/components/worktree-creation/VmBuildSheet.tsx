import React from 'react'
import { openCloudWorkspacesHome } from '../cloud-workspaces/cloud-workspaces-home-nav'
import { AlertTriangle, ChevronRight, CircleAlert, CircleCheck, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { openAppHttpLink } from '@/lib/browser/navigation/app-http-link-open'
import { useOrcaBillingStatus } from '@/components/billing/use-orca-billing-status'
import { cn } from '@/lib/utils'
import { useAppStore } from '@/store'
import { useTranslate, type Translate } from '@/i18n/use-translate'
import {
  isAwaitingVmEnvironmentCheckDecision,
  resolveVmEnvironmentCheckDecision
} from '@/lib/ephemeral-vm-environment-check-decision'
import { openPlansPage } from '@/components/billing/plans/plans-page-store'
import { ORCA_BILLING_OVERAGE_SECTION_ID } from '@/components/new-workspace/orca-cloud-run-target-access'
import type { PendingWorktreeCreation } from '@/lib/workspace/creation/pending-worktree-creation'
import { toast } from 'sonner'
import type { EnvironmentSetupFailureContext } from '../../../../shared/environment-setup-agent-prompt'
import { formatEnvironmentDoctorChecks } from '../../../../shared/environment-doctor-types'
import { VmBuildStepRow } from './VmBuildStepRow'
import { firstBuildLogErrorLine, VmBuildLog } from './VmBuildLog'
import { VmBuildFailureCard } from './VmBuildFailureCard'
import { VmBuildAgentSignInRow } from './VmBuildAgentSignInRow'
import { VmBuildSecretsRow } from '../cloud-secrets-ask/VmBuildSecretsRow'
import { OrcaCloudQueuedPrompt } from '@/components/orca-cloud/OrcaCloudQueuedPrompt'
import {
  classifyVmBuildFailure,
  isAccountGate,
  isBillingFailure,
  nothingStarted,
  type VmBuildFailure
} from './vm-build-failure'
import { deriveVmBuildSteps, isOrcaCloudBuild, type VmBuildStep } from './vm-build-steps'
import { useMinimumRunningSteps } from './use-minimum-running-steps'
import { useRetryAfterCloudSignIn } from './use-retry-after-cloud-sign-in'
import { typedComposerPrompt } from './vm-build-composer-return'
import { requestOrcaCloudAfterCheckout } from '@/lib/orca-cloud-after-checkout'
import {
  connectOrcaCloudGitHub,
  orcaCloudRepoName,
  PUSH_TO_GITHUB_URL
} from './vm-build-repo-actions'
import {
  recordCloudStartSample,
  useVmBuildStepTimings,
  type VmBuildStepTimings
} from './vm-build-timing'
import { cloneStageLabel, headerTitle, stepLabel, type SheetState } from './vm-build-sheet-copy'
import { humanizeOrcaCloudLogLine, latestOrcaCloudPhaseLabel } from './orca-cloud-build-log'
import {
  orcaCloudCloneProgress,
  orcaCloudPlannedRepoMode
} from '@/lib/orca-cloud/orca-cloud-clone-progress'

const NO_STAMPS: readonly number[] = []
const SUPPORT_URL = 'https://github.com/stablyai/orca/issues/new'

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
  const stepById = (id: VmBuildStep['id']): VmBuildStep =>
    steps.find((candidate) => candidate.id === id) ?? steps[0]
  if (failure?.kind === 'checks') {
    return {
      step: stepLabel(stepById('checks'), cloud, t),
      error: failure.problems
        .filter((check) => check.status === 'fail')
        .map((check) => check.message)
        .join(' '),
      log: formatEnvironmentDoctorChecks(failure.problems).join('\n')
    }
  }
  return {
    step: stepLabel(stepById('provision'), cloud, t),
    error: error ?? '',
    log: entry.provisioningLog
  }
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
  onReturnToComposer,
  onEditRecipe,
  agentSignInRow,
  secretsRow,
  stepTimings
}: {
  creationId: string
  entry: PendingWorktreeCreation
  now: number
  elapsedLabel: string
  error: string | null
  onCancel: () => void
  onRetry: () => void
  /** Leaves the build; when a VM is still up the caller confirms before it is deleted. */
  onDismiss: () => void
  /** Leaves a refused build for the composer with its prompt; `local` runs it on this computer. */
  onReturnToComposer: (options: { local: boolean }) => void
  onEditRecipe: () => void
  /** Fixtures only: a fixed sign-in row in place of the live one. */
  agentSignInRow?: React.ReactNode
  /** Fixtures only: a fixed Secrets row (null for none) in place of the live one. */
  secretsRow?: React.ReactNode
  /** Fixtures only: measured step timings in place of the control plane's. */
  stepTimings?: VmBuildStepTimings
}): React.JSX.Element {
  const t = useTranslate()
  const logId = React.useId()
  const firstErrorLine = React.useMemo(
    () => firstBuildLogErrorLine(entry.provisioningLog ?? ''),
    [entry.provisioningLog]
  )
  const cloud = isOrcaCloudBuild(entry)
  // Clone and update starts are measured apart (the boot plan names the kind before the step runs).
  const startKind = cloud
    ? (orcaCloudCloneProgress(entry.provisioningLog ?? '', [])?.mode ??
      orcaCloudPlannedRepoMode(entry.provisioningLog ?? ''))
    : null
  const measuredTimings = useVmBuildStepTimings(cloud && stepTimings === undefined, startKind)
  const timings = stepTimings ?? measuredTimings
  const formatLine = React.useMemo(
    () => (cloud ? (line: string) => humanizeOrcaCloudLogLine(line, t) : undefined),
    [cloud, t]
  )
  const [logOpen, setLogOpen] = React.useState(!cloud)
  const signingIn = useAppStore((state) => Boolean(state.orcaProfileSignInProgress))
  const recipe = entry.request.ephemeralVmRecipe
  const failure = classifyVmBuildFailure({ entry, error, cloud })
  const gated = isAccountGate(failure)
  const billing = useOrcaBillingStatus(isBillingFailure(failure))
  // Unknown roles get the owner's copy; only a known member is told to ask someone else.
  const canManageBilling =
    billing.result?.status !== 'ok' || billing.result.entitlement.canManageBilling
  const derived = deriveVmBuildSteps(entry, now, { cloud }).map((step) =>
    nothingStarted(failure) && step.state === 'failed'
      ? { ...step, state: 'pending' as const, elapsedMs: null }
      : step
  )
  const steps = useMinimumRunningSteps(derived, failure === null, now)
  // JA-11: this computer's own "Start sandbox" durations drive the next sheet's hint.
  const provisionMs = cloud
    ? derived.find((step) => step.id === 'provision' && step.state === 'done')?.elapsedMs
    : null
  React.useEffect(() => {
    if (provisionMs && startKind) {
      recordCloudStartSample(creationId, startKind, provisionMs)
    }
  }, [creationId, provisionMs, startKind])
  const state: SheetState = failure
    ? failure.kind === 'checks'
      ? 'attention'
      : 'failed'
    : steps.at(-1)?.state === 'done'
      ? 'ready'
      : 'building'
  const building = state === 'building'

  const sourceRepo = useAppStore((state) =>
    recipe ? state.repos.find((repo) => repo.id === recipe.sourceRepoId) : undefined
  )
  const repoName = orcaCloudRepoName(sourceRepo)
  const [connectingGitHub, setConnectingGitHub] = React.useState(false)
  const connectGitHub = (): void => {
    setConnectingGitHub(true)
    void connectOrcaCloudGitHub().finally(() => setConnectingGitHub(false))
  }

  const retryAfterSignIn = useRetryAfterCloudSignIn(failure?.kind === 'signIn', onRetry)
  const signIn = (): void => {
    void useAppStore
      .getState()
      .connectCurrentOrcaProfile()
      .then((result) => {
        if (result?.status === 'connected') {
          retryAfterSignIn()
        }
      })
      .catch((signInError: unknown) => {
        toast.error(signInError instanceof Error ? signInError.message : String(signInError))
      })
  }

  return (
    <div data-vm-build-sheet className="flex min-h-full justify-center pt-12">
      <div className="flex w-full max-w-2xl flex-col gap-4">
        <div className="flex min-h-7 items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <span className="grid size-4 shrink-0 place-items-center">
              {building ? (
                <Loader2 aria-hidden className="size-4 text-muted-foreground animate-spin" />
              ) : state === 'ready' ? (
                <CircleCheck aria-hidden className="size-4 text-foreground" />
              ) : gated ? (
                <CircleAlert aria-hidden className="size-4 text-muted-foreground" />
              ) : (
                <AlertTriangle
                  aria-hidden
                  // Failed checks leave a running sandbox that needs a decision, not a broken start.
                  className={cn(
                    'size-4 motion-safe:animate-in motion-safe:fade-in-0 motion-safe:zoom-in-90 motion-safe:duration-200',
                    failure?.kind === 'checks' && !cloud
                      ? 'text-status-warning-text'
                      : 'text-destructive'
                  )}
                />
              )}
            </span>
            {/* Retry lands focus here once the failure card collapses. The card announces failures. */}
            <h2
              data-vm-build-heading
              tabIndex={-1}
              aria-live={failure ? 'off' : 'polite'}
              className="text-sm font-medium text-foreground outline-none"
            >
              {headerTitle(state, cloud, t, failure?.kind === 'create')}
            </h2>
            {/* Orca Cloud: each step carries its own timer, so the header has none. */}
            {gated || cloud ? null : (
              <span className="text-xs tabular-nums text-muted-foreground">{elapsedLabel}</span>
            )}
          </div>
          {building ? (
            <Button type="button" variant="ghost" size="xs" onClick={onCancel}>
              {t(
                'auto.components.worktree.creation.WorktreeCreationPanel.cancelProvisioning',
                'Cancel'
              )}
            </Button>
          ) : null}
        </div>

        <div>
          {/* An account refusal happens before anything starts, so there are no steps to show. */}
          {gated ? null : (
            <ol className="flex flex-col rounded-lg border border-border bg-card px-4 py-2 text-sm">
              {steps.map((step) => (
                <VmBuildStepRow
                  key={step.id}
                  step={step}
                  cloud={cloud}
                  detail={
                    cloud && step.id === 'provision' && step.state === 'running'
                      ? latestOrcaCloudPhaseLabel(entry.provisioningLog ?? '', t)
                      : step.id === 'clone' && step.state === 'running'
                        ? cloneStageLabel(step.stage, t, step.cloneMode)
                        : null
                  }
                  timing={timings[step.id] ?? null}
                  t={t}
                />
              ))}
              {/* Orca Cloud: agent setup happens after create (the setup page and the workspace's
                  sign-in strip), so the build card has no agent row. Other VMs keep the host's own. */}
              {agentSignInRow ??
                (!cloud && entry.vmEnvironmentId ? (
                  <VmBuildAgentSignInRow
                    creationId={creationId}
                    environmentId={entry.vmEnvironmentId}
                  />
                ) : null)}
              {secretsRow !== undefined ? (
                secretsRow
              ) : cloud ? (
                <VmBuildSecretsRow entry={entry} />
              ) : null}
            </ol>
          )}

          <VmBuildFailureCard
            failure={failure}
            cloud={cloud}
            vmKept={
              failure?.kind === 'checks'
                ? failure.sandbox !== 'deleted'
                : Boolean(entry.request.ephemeralVmRuntimeId)
            }
            firstErrorLine={firstErrorLine}
            canFixWithAgent={Boolean(recipe)}
            canManageBilling={canManageBilling}
            signingIn={signingIn}
            connectingGitHub={connectingGitHub}
            repoName={repoName}
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
              // A paused create deletes this sandbox and starts over; one already gone just retries.
              onStartAgain: () =>
                isAwaitingVmEnvironmentCheckDecision(creationId)
                  ? resolveVmEnvironmentCheckDecision(creationId, 'restart')
                  : onRetry(),
              // Nothing was created, so leaving a billing refusal hands the typed prompt back.
              onDismiss:
                isBillingFailure(failure) && typedComposerPrompt(entry).trim()
                  ? () => onReturnToComposer({ local: false })
                  : onDismiss,
              onSeePlans: () => {
                // Once paid, the plans dialog closes and retries this create.
                requestOrcaCloudAfterCheckout({ kind: 'retry', creationId })
                openPlansPage('sandbox')
              },
              onCreateLocally: () => onReturnToComposer({ local: true }),
              onOpenBilling: () => {
                const store = useAppStore.getState()
                store.openSettingsTarget({
                  pane: 'cloud-billing',
                  repoId: null,
                  // "Turn on overage" / "Raise spend cap" land on the overage card itself; the
                  // payment notice is at the top of the section already.
                  ...(failure?.kind === 'payment'
                    ? {}
                    : { sectionId: ORCA_BILLING_OVERAGE_SECTION_ID })
                })
                store.openSettingsPage()
              },
              onSignIn: signIn,
              // Your workspaces on Home, where you can put one to sleep or delete it.
              onShowWorkspaces: () => openCloudWorkspacesHome({ running: true }),
              onContactSupport: () => openAppHttpLink(SUPPORT_URL),
              onConnectGitHub: connectGitHub,
              onPushToGitHub: () => openAppHttpLink(PUSH_TO_GITHUB_URL)
            }}
          />
        </div>

        {building ? <OrcaCloudQueuedPrompt creationId={creationId} /> : null}

        {cloud && !gated ? (
          <Button
            type="button"
            variant="ghost"
            size="xs"
            aria-expanded={logOpen}
            aria-controls={logId}
            onClick={() => setLogOpen(!logOpen)}
            className="self-start"
          >
            <ChevronRight
              aria-hidden
              className={cn(
                'transition-transform duration-150 motion-reduce:transition-none',
                logOpen && 'rotate-90'
              )}
            />
            {logOpen
              ? t('auto.components.worktree.creation.VmBuildSheet.hideLogs', 'Hide logs')
              : t('auto.components.worktree.creation.VmBuildSheet.viewLogs', 'View logs')}
          </Button>
        ) : null}
        {logOpen && !gated ? (
          <VmBuildLog
            id={logId}
            log={entry.provisioningLog ?? ''}
            stamps={entry.provisioningLogStamps ?? NO_STAMPS}
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
