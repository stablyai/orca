import {
  recognizeAgentProcessFromCommandLine,
  type RecognizedAgentProcess
} from './agent-process-recognition'

export type ForegroundProcessCandidate = {
  pid: number
  ppid: number
  command: string
  depth: number
  stat?: string
}

export type SelectedForegroundProcess = {
  candidate: ForegroundProcessCandidate
  recognized: RecognizedAgentProcess
}

/**
 * Select a foreground agent without letting a vendor helper steal an outer
 * agent's identity when both names occur in one process lineage.
 */
export function selectForegroundProcessCandidate(
  candidates: readonly ForegroundProcessCandidate[],
  ancestryCandidates: readonly ForegroundProcessCandidate[] = candidates
): SelectedForegroundProcess | null {
  const recognized = candidates.flatMap((candidate) => {
    const agent = recognizeAgentProcessFromCommandLine(candidate.command)
    return agent ? [{ candidate, recognized: agent }] : []
  })
  if (recognized.length === 0) {
    return null
  }

  const agentNames = new Set(recognized.map(({ recognized: agent }) => agent.agent))
  if (agentNames.size > 1) {
    const candidatesByPid = new Map(
      ancestryCandidates.map((candidate) => [candidate.pid, candidate])
    )
    const outer = [...recognized].sort(
      (left, right) => left.candidate.depth - right.candidate.depth
    )[0]
    if (!outer) {
      return null
    }
    const descendsFromOuter = makeAncestorReachabilityTest(outer.candidate, candidatesByPid)
    if (!recognized.every((entry) => descendsFromOuter(entry.candidate))) {
      // Distinct sibling agents do not provide a trustworthy identity.
      return null
    }
    return outer
  }

  return recognized.reduce((best, current) =>
    foregroundCandidateScore(current.candidate) > foregroundCandidateScore(best.candidate)
      ? current
      : best
  )
}

function foregroundCandidateScore(candidate: ForegroundProcessCandidate): number {
  return (candidate.stat?.includes('+') ? 10_000 : 0) + candidate.depth
}

/**
 * "Does this candidate's parent chain reach `ancestor`?", memoized per pid. The memo
 * is captured by the returned closure alongside the one ancestor and one process-table
 * snapshot it was computed against, so it cannot be reused across a different ancestor
 * or a later capture — every call site builds a fresh test from a fresh snapshot.
 */
function makeAncestorReachabilityTest(
  ancestor: ForegroundProcessCandidate,
  candidatesByPid: ReadonlyMap<number, ForegroundProcessCandidate>
): (descendant: ForegroundProcessCandidate) => boolean {
  const reaches = new Map<number, boolean>()
  return (descendant) => {
    let currentPid = descendant.pid
    // Every pid on the walk shares the walk's verdict, and `visited` also stops a
    // ppid cycle (a reparented or wrapped table can report one) from spinning forever.
    const visited = new Set<number>()
    let matches = true
    while (currentPid !== ancestor.pid) {
      const cached = reaches.get(currentPid)
      if (cached !== undefined) {
        matches = cached
        break
      }
      if (visited.has(currentPid)) {
        matches = false
        break
      }
      visited.add(currentPid)
      const current = candidatesByPid.get(currentPid)
      if (!current) {
        matches = false
        break
      }
      currentPid = current.ppid
    }
    for (const pid of visited) {
      reaches.set(pid, matches)
    }
    return matches
  }
}
