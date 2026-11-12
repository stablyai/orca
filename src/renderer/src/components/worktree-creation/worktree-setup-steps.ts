import {
  getVisibleCheckoutProgress,
  type PendingWorktreeCreation,
  type WorktreeCreationPhase
} from '@/lib/workspace/creation/pending-worktree-creation'

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
  | 'status'
  | 'phase'
  | 'indeterminate'
  | 'phaseLog'
  | 'startedAt'
  | 'checkoutProgress'
  | 'chatHandedOffAt'
>

const PHASE_STEPS: readonly { phase: WorktreeCreationPhase; id: WorktreeSetupStepId }[] = [
  { phase: 'preparing', id: 'prepare' },
  { phase: 'fetching', id: 'fetch' },
  { phase: 'creating', id: 'create' }
]

function startAgentStep(entry: SetupStepEntry, now: number): WorktreeSetupStep {
  const startedAt = entry.chatHandedOffAt
  if (startedAt === undefined) {
    return { id: 'start-agent', state: 'pending', elapsedMs: null, percent: null }
  }
  return entry.status === 'error'
    ? { id: 'start-agent', state: 'failed', elapsedMs: null, percent: null }
    : { id: 'start-agent', state: 'running', elapsedMs: now - startedAt, percent: null }
}

/** Checklist rows for a pending chat's worktree; the agent row runs once the worktree is ready and the chat opens. */
export function deriveWorktreeSetupSteps(entry: SetupStepEntry, now: number): WorktreeSetupStep[] {
  const handedOffAt = entry.chatHandedOffAt
  // A failure after the worktree exists belongs to the agent row, not to a worktree step.
  const failed = entry.status === 'error' && handedOffAt === undefined
  if (entry.indeterminate) {
    return [
      {
        id: 'setup',
        state: handedOffAt !== undefined ? 'done' : failed ? 'failed' : 'running',
        elapsedMs:
          handedOffAt !== undefined
            ? handedOffAt - entry.startedAt
            : failed
              ? null
              : now - entry.startedAt,
        percent: null
      },
      startAgentStep(entry, now)
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
    const endedAt = entered[at + 1]?.at ?? handedOffAt
    if (endedAt !== undefined) {
      steps.push({ id, state: 'done', elapsedMs: endedAt - record.at, percent: null })
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
  steps.push(startAgentStep(entry, now))
  return steps
}
