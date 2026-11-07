import type { SshConnectionState } from '../../../../shared/ssh-types'
import { useAppStore } from '../../store'

// Bound parallel probes so one 30s SSH timeout cannot serialize the target list or flood IPC with an unbounded burst.
const HYDRATION_FANOUT = 4

export async function hydrateDirectSshInitialState(
  isStopped: () => boolean,
  watermarkByTargetId: ReadonlyMap<string, number>,
  applySshConnectionStateChange: (targetId: string, state: SshConnectionState) => void,
  /** Every saved target, including ones that never publish a state. */
  onTargetsListed?: (targetIds: string[]) => void
): Promise<void> {
  try {
    const targets = await window.api.ssh.listTargets()
    if (isStopped()) {
      return
    }
    // Keep loaded target evidence independent of best-effort tombstone RPC; merge concurrent writes after its await (#9911).
    useAppStore.getState().setSshTargetsMetadata(targets)
    onTargetsListed?.(targets.map((target) => target.id))
    const hydrateRemovedLabels = async (): Promise<void> => {
      try {
        const removedLabels = await window.api.ssh.listRemovedTargetLabels()
        if (!isStopped()) {
          useAppStore.getState().setRemovedSshTargetLabels(removedLabels)
        }
      } catch (error) {
        // Best-effort: a host without this RPC still gets its target list.
        console.warn('[direct-ssh] failed to load removed SSH target labels:', error)
      }
    }
    void hydrateRemovedLabels()
    let nextIndex = 0
    const drainTargets = async (): Promise<void> => {
      while (nextIndex < targets.length && !isStopped()) {
        const target = targets[nextIndex]
        nextIndex += 1
        const hydrationWatermark = watermarkByTargetId.get(target.id) ?? 0
        try {
          const state = await window.api.ssh.getState({ targetId: target.id })
          if (
            !isStopped() &&
            state &&
            (watermarkByTargetId.get(target.id) ?? 0) === hydrationWatermark
          ) {
            applySshConnectionStateChange(target.id, state as SshConnectionState)
          }
        } catch (error) {
          // Thrown lookups prove no status; keep that target unverifiable and continue queued targets.
          console.warn(`[direct-ssh] failed to hydrate SSH state for ${target.id}:`, error)
        }
      }
    }
    await Promise.all(
      Array.from({ length: Math.min(HYDRATION_FANOUT, targets.length) }, drainTargets)
    )
  } catch (error) {
    console.warn('[direct-ssh] failed to hydrate SSH targets:', error)
  }
}
