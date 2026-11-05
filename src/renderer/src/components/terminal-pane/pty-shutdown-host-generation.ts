import type { RuntimeClientEvent } from '../../../../shared/runtime-client-events'

type HostSleepPhase = Extract<RuntimeClientEvent, { type: 'worktreeTerminalSleepState' }>['phase']
type ActiveHostSleepDisposition = {
  generation: number
  phase: 'pending' | 'committed'
}

const hostSleepPhaseByPtyId = new Map<
  string,
  { generation: number; phase: HostSleepPhase; expiresAt: number }
>()
// Why: retain terminal ordering longer than live guards so delayed frames cannot resurrect a settled sleep.
const HOST_SLEEP_PHASE_GRACE_MS = 60_000

function pruneHostSleepPhases(now = Date.now()): void {
  for (const [key, state] of hostSleepPhaseByPtyId) {
    if (state.expiresAt <= now) {
      hostSleepPhaseByPtyId.delete(key)
    }
  }
}

export function shouldApplyHostSleepPhase(
  key: string,
  generation: number,
  phase: HostSleepPhase,
  disposition?: ActiveHostSleepDisposition
): boolean {
  pruneHostSleepPhases()
  const prior = hostSleepPhaseByPtyId.get(key)
  if (
    (prior && generation < prior.generation) ||
    (disposition && generation < disposition.generation)
  ) {
    return false
  }
  if (disposition?.generation === generation) {
    if (disposition.phase === 'committed' && phase !== 'committed' && phase !== 'woken') {
      return false
    }
  }
  if (prior?.generation === generation) {
    if (phase === 'started') {
      if (
        prior.phase !== 'started' ||
        disposition?.generation !== generation ||
        disposition.phase !== 'pending'
      ) {
        return false
      }
    } else if (phase === 'committed') {
      if (
        prior.phase !== 'started' &&
        !(
          prior.phase === 'committed' &&
          disposition?.generation === generation &&
          disposition.phase === 'committed'
        )
      ) {
        return false
      }
    } else if (phase === 'cancelled') {
      if (prior.phase !== 'started') {
        return false
      }
    } else if (prior.phase !== 'committed' && prior.phase !== 'started') {
      return false
    }
  }
  hostSleepPhaseByPtyId.delete(key)
  hostSleepPhaseByPtyId.set(key, {
    generation,
    phase,
    expiresAt: Date.now() + HOST_SLEEP_PHASE_GRACE_MS
  })
  pruneHostSleepPhases()
  return true
}
