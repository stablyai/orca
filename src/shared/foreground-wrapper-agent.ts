import {
  recognizeAgentProcess,
  recognizeAgentProcessFromCommandLine,
  type RecognizedAgentProcess
} from './agent-process-recognition'
import { getSyntheticAgentTitleProfile } from './synthetic-agent-title'

export type ForegroundAgentCandidate = {
  pid: number
  ppid: number
  command: string
  name?: string
}

export function shouldInspectOuterWrapperForegroundProcess(
  process: RecognizedAgentProcess
): boolean {
  // Why: only Pi is currently embedded by a same-group wrapper; scanning OMP would add a subprocess to every relay poll.
  return process.agent === 'pi'
}

/** Same gate for a bare process name, recognizing it first. */
export function shouldInspectOuterWrapperForegroundName(processName: string | null): boolean {
  const recognized = recognizeAgentProcess(processName)
  return recognized !== null && shouldInspectOuterWrapperForegroundProcess(recognized)
}

/** Collapse to the outermost same-title-group ancestor: OMP embeds Pi, so depth alone cannot distinguish wrappers from siblings. */
export function resolveOuterWrapperForegroundProcess(
  winner: RecognizedAgentProcess,
  winnerCandidate: ForegroundAgentCandidate,
  descendants: readonly ForegroundAgentCandidate[]
): string {
  return resolveOuterWrapperForegroundIdentity(winner, winnerCandidate, descendants).processName
}

/** Keep the reported ancestor’s pid with its name so an embedded leaf’s exit does not look like wrapper termination. */
export function resolveOuterWrapperForegroundIdentity(
  winner: RecognizedAgentProcess,
  winnerCandidate: ForegroundAgentCandidate,
  descendants: readonly ForegroundAgentCandidate[]
): { processName: string; processId: number } {
  const winnerGroup = getSyntheticAgentTitleProfile(winner.agent)?.titleIdentityGroup
  if (!winnerGroup) {
    return { processName: winner.processName, processId: winnerCandidate.pid }
  }
  const candidatesByPid = new Map(descendants.map((candidate) => [candidate.pid, candidate]))
  const seen = new Set<number>([winnerCandidate.pid])
  let outerProcessName = winner.processName
  let outerProcessId = winnerCandidate.pid
  let parentPid = winnerCandidate.ppid
  while (!seen.has(parentPid)) {
    seen.add(parentPid)
    const candidate = candidatesByPid.get(parentPid)
    if (!candidate) {
      break
    }
    const recognized =
      recognizeAgentProcessFromCommandLine(candidate.command) ??
      recognizeAgentProcessFromCommandLine(candidate.name)
    if (
      recognized &&
      getSyntheticAgentTitleProfile(recognized.agent)?.titleIdentityGroup === winnerGroup
    ) {
      outerProcessName = recognized.processName
      outerProcessId = candidate.pid
    }
    parentPid = candidate.ppid
  }
  return { processName: outerProcessName, processId: outerProcessId }
}
