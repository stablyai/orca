import type { ExecutionHostId } from '../../../shared/execution-host'
import type { LocalCapacitySignal } from '../../../shared/local-capacity-signal-types'
import type { RuntimeHostContact } from '../../../shared/runtime-host-contact'
import type { SshConnectionStatus } from '../../../shared/ssh-types'

/** A paired Orca server that could run a new workspace. */
export type RemoteServerRunTargetCandidate = {
  hostId: ExecutionHostId
  contact: RuntimeHostContact
}

/** An SSH host that could run a new workspace. `status` is null before the store has state. */
export type SshRunTargetCandidate = {
  hostId: ExecutionHostId
  status: SshConnectionStatus | null
}

export type DefaultRunTargetSuggestionInput = {
  signal: LocalCapacitySignal | null
  preferRunnerWhenLocalWeak: boolean
  /** Runners only — the local host is where the work already is, never a suggestion target. */
  remoteServerCandidates: readonly RemoteServerRunTargetCandidate[]
  sshCandidates: readonly SshRunTargetCandidate[]
}

/** Why this machine looked too weak to run new work — the UI localizes each cause itself. */
export type LocalCapacityCause = 'onBattery' | 'lowMemory' | 'lowCpu'

export type DefaultRunTargetSuggestion = {
  hostId: ExecutionHostId
  /** Never empty; one entry per true flag, in `LocalCapacitySignal` field order. */
  causes: LocalCapacityCause[]
}

// Why: the flag booleans are the signal, not the signal's phrase strings — a flag with no phrase
// must still route, and the phrases are English prose this module must not hand to the UI.
function collectLocalCapacityCauses(signal: LocalCapacitySignal): LocalCapacityCause[] {
  const causes: LocalCapacityCause[] = []
  if (signal.onBattery) {
    causes.push('onBattery')
  }
  if (signal.lowMemory) {
    causes.push('lowMemory')
  }
  if (signal.lowCpu) {
    causes.push('lowCpu')
  }
  return causes
}

/**
 * Defaults a new workspace to a healthy runner while this machine looks too weak to run it well.
 *
 * Pure: the caller owns the capacity sample, the setting, and the candidates it can actually
 * create on. Remote-server and SSH health stay separate inputs because they are separate
 * vocabularies — `RuntimeHostContact` answers "can we reach the host", `SshConnectionStatus`
 * answers the SSH lifecycle question — and neither is a PTY liveness verdict
 * (docs/reference/ssh-execution-boundary.md). Explicit user choices never reach this module.
 */
export function suggestDefaultRunTarget(
  input: DefaultRunTargetSuggestionInput
): DefaultRunTargetSuggestion | null {
  const { signal, preferRunnerWhenLocalWeak, remoteServerCandidates, sshCandidates } = input
  if (!preferRunnerWhenLocalWeak || !signal) {
    return null
  }
  const causes = collectLocalCapacityCauses(signal)
  if (causes.length === 0) {
    return null
  }
  // Why: only `live` is healthy. `unverifiable` is a probe we do not have an answer for, and
  // `refused` / `retired` mean the pairing is over — none of the three proves the host reachable.
  // Why paired servers first: they are the peer model the boundary doc prefers over direct SSH for
  // work that must outlive this client, so they win when both kinds are healthy.
  const hostId =
    remoteServerCandidates.find((candidate) => candidate.contact.verdict === 'live')?.hostId ??
    sshCandidates.find((candidate) => candidate.status === 'connected')?.hostId
  if (!hostId) {
    return null
  }
  return { hostId, causes }
}
