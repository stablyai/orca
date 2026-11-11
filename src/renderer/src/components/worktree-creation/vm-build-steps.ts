import {
  getVisibleCheckoutProgress,
  type PendingWorktreeCreation,
  type WorktreeCreationPhase
} from '@/lib/workspace/creation/pending-worktree-creation'
import type { WorktreeSetupStepState } from './worktree-setup-steps'
import { orcaCloudCloneProgress } from './orca-cloud-build-log'

/** `clone` is Orca Cloud only: the repo clones in the sandbox after it starts. */
export type VmBuildStepId = 'provision' | 'clone' | 'checks' | 'create'

export type VmBuildStep = {
  id: VmBuildStepId
  state: WorktreeSetupStepState
  /** Done without running: an older VM server has no environment checks. */
  skipped: boolean
  /** Time spent so far (running) or in total (done/failed); null when unknown. */
  elapsedMs: number | null
  /** Git's percent while the clone or the workspace step checks out files. */
  percent: number | null
  /** Clone only: what git is doing now (`checkout` = writing the files). */
  stage?: 'download' | 'checkout'
  /** When the step started, if it has. */
  startedAt: number | null
}

type VmBuildEntry = Pick<
  PendingWorktreeCreation,
  | 'status'
  | 'phase'
  | 'environmentCheck'
  | 'phaseLog'
  | 'startedAt'
  | 'checkoutProgress'
  | 'worktreeId'
  | 'errorAt'
  | 'provisioningLog'
  | 'provisioningLogStamps'
>

export function isOrcaCloudBuild(entry: Pick<PendingWorktreeCreation, 'request'>): boolean {
  return entry.request.ephemeralVmRecipe?.provider === 'orca-cloud'
}

function phaseStart(
  entry: VmBuildEntry,
  phases: readonly WorktreeCreationPhase[]
): number | undefined {
  return entry.phaseLog?.find((record) => phases.includes(record.phase))?.at
}

function span(start: number | undefined, end: number | undefined): number | null {
  return start === undefined || end === undefined ? null : Math.max(0, end - start)
}

function step(
  id: VmBuildStepId,
  state: WorktreeSetupStepState,
  elapsedMs: number | null,
  startedAt: number | undefined,
  extra: Partial<Pick<VmBuildStep, 'skipped' | 'percent'>> = {}
): VmBuildStep {
  return {
    id,
    state,
    elapsedMs,
    startedAt: startedAt ?? null,
    skipped: extra.skipped ?? false,
    percent: extra.percent ?? null
  }
}

/**
 * Provision, then the VM's environment checks, then the workspace (fetch + checkout, folded into one
 * row). A failed step keeps the steps before it done and shows how long it ran; a worktree id means
 * the workspace is opening.
 */
export function deriveVmBuildSteps(
  entry: VmBuildEntry,
  now: number,
  { cloud = false }: { cloud?: boolean } = {}
): VmBuildStep[] {
  const check = entry.environmentCheck
  const failed = entry.status === 'error'
  const workspacePhase = entry.phase === 'fetching' || entry.phase === 'creating'
  const ready = workspacePhase && !failed && entry.worktreeId !== undefined
  const provisionAt = phaseStart(entry, ['provisioning-vm']) ?? entry.startedAt
  const createAt = phaseStart(entry, ['fetching', 'creating'])
  const clone = cloud
    ? orcaCloudCloneProgress(entry.provisioningLog ?? '', entry.provisioningLogStamps ?? [])
    : null
  const cloneAt = clone?.startedAt ?? undefined
  const afterClone = clone?.endedAt ?? check?.startedAt ?? createAt
  const provisionDone = Boolean(check) || workspacePhase || cloneAt !== undefined

  const provision = provisionDone
    ? step(
        'provision',
        'done',
        span(provisionAt, cloneAt ?? check?.startedAt ?? createAt),
        provisionAt
      )
    : failed
      ? step('provision', 'failed', span(provisionAt, entry.errorAt), provisionAt)
      : step('provision', 'running', span(provisionAt, now), provisionAt)

  // No clone lines: an environment build (prebuilt repo) or an older control plane that cloned
  // inside the start. Either way it is done once the sandbox is, with no time of its own.
  const cloneStep: VmBuildStep | null = !cloud
    ? null
    : cloneAt === undefined
      ? step('clone', provisionDone ? 'done' : 'pending', null, undefined)
      : clone?.endedAt !== null || check || workspacePhase
        ? step('clone', 'done', span(cloneAt, afterClone), cloneAt)
        : failed
          ? step('clone', 'failed', span(cloneAt, entry.errorAt), cloneAt)
          : {
              ...step('clone', 'running', span(cloneAt, now), cloneAt, {
                percent: clone?.percent ?? 0
              }),
              ...(clone?.stage ? { stage: clone.stage } : {})
            }

  const checks = !check
    ? step('checks', 'pending', null, undefined)
    : check.status === 'running'
      ? step('checks', 'running', span(check.startedAt, now), check.startedAt)
      : check.status === 'skipped'
        ? // An older VM server ran nothing, so the step says so instead of reading as verified.
          step('checks', 'done', null, check.startedAt, { skipped: true })
        : step(
            'checks',
            check.status === 'failed' ? 'failed' : 'done',
            span(check.startedAt, check.finishedAt),
            check.startedAt
          )

  const create = !workspacePhase
    ? step('create', 'pending', null, undefined)
    : ready
      ? step('create', 'done', span(createAt, now), createAt)
      : failed
        ? step('create', 'failed', span(createAt, entry.errorAt), createAt)
        : step('create', 'running', span(createAt, now), createAt, {
            percent: getVisibleCheckoutProgress(entry)?.percent ?? null
          })

  return cloneStep ? [provision, cloneStep, checks, create] : [provision, checks, create]
}
