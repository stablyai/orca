import {
  getVisibleCheckoutProgress,
  type PendingWorktreeCreation,
  type WorktreeCreationPhase
} from '@/lib/workspace/creation/pending-worktree-creation'
import type { WorktreeSetupStepState } from './worktree-setup-steps'

export type VmBuildStepId = 'provision' | 'checks' | 'create'

export type VmBuildStep = {
  id: VmBuildStepId
  state: WorktreeSetupStepState
  /** Time spent so far (running) or in total (done/failed); null when unknown. */
  elapsedMs: number | null
  /** Git's checkout percent while the workspace step checks out files. */
  percent: number | null
  /** When the step started, if it has. */
  startedAt: number | null
}

/** Typical Orca Cloud step durations in seconds, shown as "usually ~Ns" while a step runs. */
export const ORCA_CLOUD_TYPICAL_STEP_SECONDS: Record<VmBuildStepId, number> = {
  provision: 5,
  checks: 3,
  create: 2
}

type StepCore = Omit<VmBuildStep, 'startedAt'>

type VmBuildEntry = Pick<
  PendingWorktreeCreation,
  | 'status'
  | 'phase'
  | 'environmentCheck'
  | 'phaseLog'
  | 'startedAt'
  | 'checkoutProgress'
  | 'worktreeId'
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

/**
 * Provision, then the VM's environment checks, then the workspace (fetch + checkout, folded into one
 * row). A failed step keeps the steps before it done; a worktree id means the workspace is opening.
 */
export function deriveVmBuildSteps(entry: VmBuildEntry, now: number): VmBuildStep[] {
  const check = entry.environmentCheck
  const failed = entry.status === 'error'
  const workspacePhase = entry.phase === 'fetching' || entry.phase === 'creating'
  const ready = workspacePhase && !failed && entry.worktreeId !== undefined
  const provisionAt = phaseStart(entry, ['provisioning-vm']) ?? entry.startedAt
  const createAt = phaseStart(entry, ['fetching', 'creating'])
  const provisionDone = Boolean(check) || workspacePhase

  const provision: StepCore = provisionDone
    ? {
        id: 'provision',
        state: 'done',
        elapsedMs: span(provisionAt, check?.startedAt ?? createAt),
        percent: null
      }
    : {
        id: 'provision',
        state: failed ? 'failed' : 'running',
        elapsedMs: failed ? null : span(provisionAt, now),
        percent: null
      }

  const checksState: WorktreeSetupStepState = !check
    ? 'pending'
    : check.status === 'running'
      ? 'running'
      : check.status === 'failed'
        ? 'failed'
        : // An older VM server ran nothing, so the step must not read as verified.
          check.status === 'skipped'
          ? 'pending'
          : 'done'
  const checks: StepCore = {
    id: 'checks',
    state: checksState,
    elapsedMs:
      checksState === 'running'
        ? span(check?.startedAt, now)
        : checksState === 'pending'
          ? null
          : span(check?.startedAt, check?.finishedAt),
    percent: null
  }

  const create: StepCore = !workspacePhase
    ? { id: 'create', state: 'pending', elapsedMs: null, percent: null }
    : ready
      ? { id: 'create', state: 'done', elapsedMs: span(createAt, now), percent: null }
      : failed
        ? { id: 'create', state: 'failed', elapsedMs: null, percent: null }
        : {
            id: 'create',
            state: 'running',
            elapsedMs: span(createAt, now),
            percent: getVisibleCheckoutProgress(entry)?.percent ?? null
          }

  return [
    { ...provision, startedAt: provisionAt },
    { ...checks, startedAt: check?.startedAt ?? null },
    { ...create, startedAt: workspacePhase ? (createAt ?? null) : null }
  ]
}
