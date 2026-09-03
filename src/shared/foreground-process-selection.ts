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
    if (
      !outer ||
      !recognized.every((entry) =>
        isAncestorOrSelf(outer.candidate, entry.candidate, candidatesByPid)
      )
    ) {
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

function isAncestorOrSelf(
  ancestor: ForegroundProcessCandidate,
  descendant: ForegroundProcessCandidate,
  candidatesByPid: ReadonlyMap<number, ForegroundProcessCandidate>
): boolean {
  let currentPid = descendant.pid
  while (currentPid !== ancestor.pid) {
    const current = candidatesByPid.get(currentPid)
    if (!current) {
      return false
    }
    currentPid = current.ppid
  }
  return true
}
