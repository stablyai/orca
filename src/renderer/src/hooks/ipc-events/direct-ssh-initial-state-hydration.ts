import type { SshConnectionState } from '../../../../shared/ssh-types'
import { useAppStore } from '../../store'
import type { DirectSshBridgeRuntime } from './direct-ssh-bridge-runtime'

/** Why: an unanswered ssh.getState burns the full 30s runtime-RPC timeout, so a serial walk
 * makes the last target wait (N-1) timeouts; a small pool keeps a wedged target from blocking
 * the rest without bursting the IPC/runtime-RPC queue on a large imported target list. */
const HYDRATION_FANOUT = 4

export async function hydrateDirectSshInitialState(
  runtime: DirectSshBridgeRuntime,
  watermarkByTargetId: ReadonlyMap<string, number>,
  applySshConnectionStateChange: (targetId: string, state: SshConnectionState) => void
): Promise<void> {
  try {
    const targets = await window.api.ssh.listTargets()
    if (runtime.isStopped()) {
      return
    }
    // Why: the loaded list is the hydration evidence (#9911) — never gate it behind the
    // best-effort tombstone RPC, whose await also lets concurrent target writes land.
    useAppStore.getState().setSshTargetsMetadata(targets)
    const hydrateRemovedLabels = async (): Promise<void> => {
      try {
        const removedLabels = await window.api.ssh.listRemovedTargetLabels()
        if (!runtime.isStopped()) {
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
      while (nextIndex < targets.length && !runtime.isStopped()) {
        const target = targets[nextIndex]
        nextIndex += 1
        const hydrationWatermark = watermarkByTargetId.get(target.id) ?? 0
        try {
          const state = await window.api.ssh.getState({ targetId: target.id })
          if (
            !runtime.isStopped() &&
            state &&
            (watermarkByTargetId.get(target.id) ?? 0) === hydrationWatermark
          ) {
            applySshConnectionStateChange(target.id, state as SshConnectionState)
          }
        } catch (error) {
          // Why: a lookup that threw observed nothing, so this target stays unverifiable —
          // never synthesize a status, and never abandon the targets queued behind it.
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
