import { isRuntimeOwnedSshTargetId } from '../../../../shared/execution-host'
import { useAppStore } from '../../store'

/** Recipe targets are not user-managed hosts. Keep their live authority separate. */
export function registerRuntimeOwnedSshStateIpcBridge(unsubs: (() => void)[]): void {
  let stopped = false
  const revisions = new Map<string, number>()
  unsubs.push(() => {
    stopped = true
  })
  unsubs.push(
    window.api.ssh.onStateChanged(({ targetId, state }) => {
      if (stopped || !isRuntimeOwnedSshTargetId(targetId)) {
        return
      }
      revisions.set(targetId, (revisions.get(targetId) ?? 0) + 1)
      useAppStore.getState().setRuntimeOwnedSshConnectionState(targetId, state)
    })
  )

  // Start after installing the listener so a late snapshot cannot undo a disconnect.
  void (async () => {
    const runtimes = await window.api.ephemeralVm.listRuntimes()
    const targets = [
      ...new Set(
        runtimes.flatMap((runtime) =>
          runtime.connectionMode === 'ssh' &&
          !runtime.runtimeEnvironmentId &&
          runtime.sshTargetId &&
          isRuntimeOwnedSshTargetId(runtime.sshTargetId)
            ? [runtime.sshTargetId]
            : []
        )
      )
    ]
    let next = 0
    await Promise.all(
      Array.from({ length: Math.min(4, targets.length) }, async () => {
        while (!stopped && next < targets.length) {
          const targetId = targets[next++]
          const revision = revisions.get(targetId) ?? 0
          try {
            const state = await window.api.ssh.getState({ targetId })
            if (!stopped && revision === (revisions.get(targetId) ?? 0)) {
              useAppStore.getState().setRuntimeOwnedSshConnectionState(targetId, state ?? null)
            }
          } catch (error) {
            console.warn('[runtime-ssh] State hydration failed:', targetId, error)
          }
        }
      })
    )
  })().catch((error) => console.warn('[runtime-ssh] Runtime hydration failed:', error))
}
