import type { ResumeCandidate, ResumeFailure } from './native-chat-resume-on-restart-grouping'
import type { ResumeRun, ResumeRunHostStatus } from './native-chat-resume-run'

/** Only current host failures create attention obligations after a run. */

/** Where one chat of the run stands, as the leading icon shows it in place of the checkbox. */
export type ResumeRunRowStatus =
  | { kind: 'in-flight'; startedAt: number; phase: 'starting' | 'ready' | null }
  | { kind: 'resumed' }
  | { kind: 'refused' }
  | { kind: 'unconfirmed' }

export type ResumeRunFilter = 'all' | 'in-progress' | 'resumed' | 'attention'

type Category = Exclude<ResumeRunFilter, 'all'> | 'other'

export type ResumeRunView = {
  rows: ResumeCandidate[]
  statusBySession: ReadonlyMap<string, ResumeRunRowStatus>
  counts: Readonly<{
    /** Every row the list holds, in the run or not. */
    all: number
    /** Chats in this run that still need resuming or did; a chat nobody needed is not counted. */
    total: number
    done: number
    inProgress: number
    resumed: number
    /** Failed or unconfirmed, this run's or an earlier one's: the rows that need the user. */
    attention: number
  }>
}

// What needs the user first, then what is still moving, then what is done.
const ORDER: Record<Category, number> = { attention: 0, 'in-progress': 1, resumed: 2, other: 3 }

export function resumeRunView(
  run: ResumeRun,
  listed: readonly ResumeCandidate[],
  failureFor: (sessionId: string) => ResumeFailure | undefined,
  filter: ResumeRunFilter,
  hostStatusFor: (sessionId: string) => ResumeRunHostStatus | undefined = () => undefined
): ResumeRunView {
  const listedById = new Map(listed.map((row) => [row.sessionId, row]))
  const continuedBySession = new Map(
    run.continued?.map((entry) => [entry.sessionId, entry.outcome])
  )
  const statusBySession = new Map<string, ResumeRunRowStatus>()
  const placed: { row: ResumeCandidate; category: Category; index: number }[] = []
  const inRun = new Set<string>()
  let inRunCount = 0
  for (const entry of run.entries) {
    const { sessionId } = entry.candidate
    inRun.add(sessionId)
    const row = listedById.get(sessionId) ?? entry.candidate
    const failure = failureFor(sessionId)
    const hostStatus = run.inFlight ? (entry.observedStatus ?? hostStatusFor(sessionId)) : undefined
    const phase = hostStatus?.restartResume?.phase
    if (run.inFlight && phase === 'skipped') {
      continue
    }
    inRunCount += 1
    if (run.inFlight && (phase === undefined || phase === 'queued' || phase === 'starting')) {
      const hostPhase = hostStatus?.hostExecutionPhase
      statusBySession.set(sessionId, {
        kind: 'in-flight',
        startedAt: run.startedAt,
        phase: phase === 'starting' ? (hostPhase === 'ready' ? 'ready' : 'starting') : null
      })
      placed.push({ row, category: 'in-progress', index: placed.length })
    } else if (
      phase === 'continued' ||
      (!run.inFlight && !failure && continuedBySession.get(sessionId) === 'continued')
    ) {
      statusBySession.set(sessionId, { kind: 'resumed' })
      placed.push({ row, category: 'resumed', index: placed.length })
    } else if (run.inFlight && (phase === 'refused' || phase === 'unconfirmed')) {
      statusBySession.set(sessionId, { kind: phase })
      placed.push({ row, category: 'attention', index: placed.length })
    } else if (failure) {
      placed.push({ row, category: 'attention', index: placed.length })
    } else if (listedById.has(sessionId)) {
      placed.push({ row, category: 'other', index: placed.length })
    }
  }
  for (const row of listed) {
    if (!inRun.has(row.sessionId)) {
      const category = failureFor(row.sessionId) ? 'attention' : 'other'
      placed.push({ row, category, index: placed.length })
    }
  }
  const count = (category: Category) => placed.filter((entry) => entry.category === category).length
  const inProgress = count('in-progress')
  return {
    rows: placed
      .filter((entry) => filter === 'all' || entry.category === filter)
      .sort((a, b) => ORDER[a.category] - ORDER[b.category] || a.index - b.index)
      .map((entry) => entry.row),
    statusBySession,
    counts: {
      all: placed.length,
      total: inRunCount,
      done: inRunCount - inProgress,
      inProgress,
      resumed: count('resumed'),
      attention: count('attention')
    }
  }
}
