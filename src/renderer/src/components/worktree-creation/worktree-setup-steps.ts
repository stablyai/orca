import {
  getVisibleCheckoutProgress,
  type PendingWorktreeCreation,
  type WorktreeCreationPhase
} from '@/lib/pending-worktree-creation'

export type WorktreeSetupStepId = 'prepare' | 'fetch' | 'create' | 'setup' | 'start-agent'

export type WorktreeSetupStepState = 'pending' | 'running' | 'done' | 'failed'

export type WorktreeSetupStep = {
  id: WorktreeSetupStepId
  state: WorktreeSetupStepState
  /** Time spent so far (running) or in total (done); null otherwise. */
  elapsedMs: number | null
  /** Git's checkout percent, only while the create step runs and git reports one. */
  percent: number | null
}

type SetupStepEntry = Pick<
  PendingWorktreeCreation,
  'status' | 'phase' | 'indeterminate' | 'phaseLog' | 'startedAt' | 'checkoutProgress'
>

const PHASE_STEPS: readonly { phase: WorktreeCreationPhase; id: WorktreeSetupStepId }[] = [
  { phase: 'preparing', id: 'prepare' },
  { phase: 'fetching', id: 'fetch' },
  { phase: 'creating', id: 'create' }
]

const START_AGENT: WorktreeSetupStep = {
  id: 'start-agent',
  state: 'pending',
  elapsedMs: null,
  percent: null
}

/** Checklist rows for a pending chat's worktree; the agent row stays pending because this surface ends before it starts. */
export function deriveWorktreeSetupSteps(entry: SetupStepEntry, now: number): WorktreeSetupStep[] {
  const failed = entry.status === 'error'
  if (entry.indeterminate) {
    return [
      {
        id: 'setup',
        state: failed ? 'failed' : 'running',
        elapsedMs: failed ? null : now - entry.startedAt,
        percent: null
      },
      START_AGENT
    ]
  }
  const log = entry.phaseLog?.length
    ? entry.phaseLog
    : [{ phase: entry.phase, at: entry.startedAt }]
  const entered = log.filter((record) => PHASE_STEPS.some(({ phase }) => phase === record.phase))
  const lastEntered = entered.at(-1)
  const lastIndex = PHASE_STEPS.findIndex(({ phase }) => phase === lastEntered?.phase)
  const steps: WorktreeSetupStep[] = []
  PHASE_STEPS.forEach(({ phase, id }, index) => {
    const at = entered.findIndex((record) => record.phase === phase)
    if (at === -1) {
      // Prepare shows only when it ran; a passed-over phase never claims it ran.
      if (phase !== 'preparing' && index > lastIndex) {
        steps.push({ id, state: 'pending', elapsedMs: null, percent: null })
      }
      return
    }
    const record = entered[at]
    const next = entered[at + 1]
    if (next) {
      steps.push({ id, state: 'done', elapsedMs: next.at - record.at, percent: null })
      return
    }
    steps.push(
      failed
        ? { id, state: 'failed', elapsedMs: null, percent: null }
        : {
            id,
            state: 'running',
            elapsedMs: now - record.at,
            percent:
              phase === 'creating' ? (getVisibleCheckoutProgress(entry)?.percent ?? null) : null
          }
    )
  })
  steps.push(START_AGENT)
  return steps
}
