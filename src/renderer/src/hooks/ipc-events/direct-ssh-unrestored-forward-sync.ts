import { useAppStore } from '@/store'
import type { UnrestoredPortForward } from '../../../../shared/ssh-types'

/**
 * Saved forwards that aren't open, mirrored from main. Main pushes the list with every forward
 * change; a read applies only if no push or newer read for that host landed since it started,
 * so a stale snapshot can't bring back a removed forward.
 */
export function createDirectSshUnrestoredForwardSync(isStopped: () => boolean): {
  refresh: (targetId: string) => void
  applyPush: (targetId: string, unrestored: UnrestoredPortForward[]) => void
} {
  const sequenceByTargetId = new Map<string, number>()
  const bump = (targetId: string): number => {
    const next = (sequenceByTargetId.get(targetId) ?? 0) + 1
    sequenceByTargetId.set(targetId, next)
    return next
  }
  return {
    refresh: (targetId) => {
      const sequence = bump(targetId)
      void window.api.ssh
        .listUnrestoredPortForwards({ targetId })
        .then((unrestored) => {
          if (!isStopped() && sequenceByTargetId.get(targetId) === sequence) {
            useAppStore.getState().setUnrestoredPortForwards(targetId, unrestored)
          }
        })
        .catch(() => {})
    },
    applyPush: (targetId, unrestored) => {
      bump(targetId)
      useAppStore.getState().setUnrestoredPortForwards(targetId, unrestored)
    }
  }
}
