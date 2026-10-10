import type { SshConnectionState } from '../../../shared/ssh-types'
import { timeRendererStartupStep } from './startup-diagnostics'
import { reconnectSshTargetForRendererStartup } from './ssh-startup-reconnect'

const SSH_RECONNECT_TIMEOUT_MS = 15_000

/**
 * Re-establishes the SSH targets that were live at shutdown before terminal reconnect, so
 * SSH-backed tabs route through pty.attach. Passphrase-protected and timed-out targets are
 * handed back as deferred so their PTYs reattach on tab focus instead of stacking dialogs.
 *
 * Only `blockingConnectionIds` are awaited. Every other target connects in the background and
 * is registered as deferred up front, so an unreachable host cannot hold local terminal
 * restoration for the reconnect timeout. Background connects keep running in main; the pane's
 * deferred flow joins the same in-flight `ssh.connect` on tab focus.
 */
export async function restoreSshConnectionsForStartup(args: {
  connectionIds: string[]
  /** Targets whose panes mount as soon as the startup gate opens. Omitted = await all. */
  blockingConnectionIds?: readonly string[]
  setDeferredSshReconnectTargets: (targetIds: string[]) => void
  removeDeferredSshReconnectTarget: (targetId: string) => void
  publishSshConnectionState: (targetId: string, state: SshConnectionState) => void
}): Promise<void> {
  const {
    connectionIds,
    blockingConnectionIds,
    setDeferredSshReconnectTargets,
    removeDeferredSshReconnectTarget,
    publishSshConnectionState
  } = args
  const allTargets = await timeRendererStartupStep('ssh-list-targets', () =>
    window.api.ssh.listTargets()
  )
  const targetMap = new Map(allTargets.map((t) => [t.id, t]))
  const targets = connectionIds.map((targetId) => ({
    targetId,
    needsPassphrase: targetMap.get(targetId)?.lastRequiredPassphrase ?? false
  }))

  const passphraseTargetIds = targets.filter((t) => t.needsPassphrase).map((t) => t.targetId)
  const blocking = blockingConnectionIds ? new Set(blockingConnectionIds) : null
  const eagerTargets = targets.filter(
    (t) => !t.needsPassphrase && (blocking === null || blocking.has(t.targetId))
  )
  const backgroundTargets = targets.filter(
    (t) => !t.needsPassphrase && blocking !== null && !blocking.has(t.targetId)
  )

  const deferredTargetIds = [...passphraseTargetIds, ...backgroundTargets.map((t) => t.targetId)]
  if (deferredTargetIds.length > 0) {
    setDeferredSshReconnectTargets(deferredTargetIds)
  }

  // Why tracked: the timed-out branch below rewrites the whole deferred list, and a
  // background target that already connected must not be pushed back into it.
  const connectedBackgroundTargetIds = new Set<string>()
  // Why fired before the awaited group: a background target that lands before terminal
  // reconnect reads as an ordinary connected target, exactly as it does today.
  for (const { targetId } of backgroundTargets) {
    void reconnectSshTargetForRendererStartup({
      targetId,
      connect: (id) => window.api.ssh.connect({ targetId: id }),
      publishState: (id, state) => {
        publishSshConnectionState(id, state)
        if (state.status === 'connected') {
          // Why: a still-deferred connected target sends fresh panes down the deferred
          // spawn path instead of the normal one. Clear it as soon as it is reachable.
          connectedBackgroundTargetIds.add(id)
          removeDeferredSshReconnectTarget(id)
        }
      },
      onFailure: (id, error) => {
        console.warn(`SSH background auto-reconnect failed for ${id}:`, error)
      }
    })
  }

  // Why: treat timed-out eager targets as deferred so their PTYs reattach on tab focus (ssh.connect keeps running in main and likely finishes by then).
  const timedOutTargets: string[] = []
  await timeRendererStartupStep(
    'ssh-reconnect',
    () =>
      Promise.all(
        eagerTargets.map(async ({ targetId }) => {
          const result = await reconnectSshTargetForRendererStartup({
            targetId,
            timeoutMs: SSH_RECONNECT_TIMEOUT_MS,
            connect: (id) => window.api.ssh.connect({ targetId: id }),
            publishState: publishSshConnectionState,
            onFailure: (id, error) => {
              console.warn(`SSH auto-reconnect failed for ${id}:`, error)
            }
          })
          if (result.timedOut) {
            timedOutTargets.push(targetId)
          }
        })
      ),
    {
      eagerTargets: eagerTargets.length,
      deferredTargets: passphraseTargetIds.length,
      backgroundTargets: backgroundTargets.length
    }
  )
  if (timedOutTargets.length > 0) {
    setDeferredSshReconnectTargets([
      ...deferredTargetIds.filter((id) => !connectedBackgroundTargetIds.has(id)),
      ...timedOutTargets
    ])
  }

  // Why: older/wrapped providers may return no state from connect; poll main once as a compatibility fallback before terminal restoration.
  for (const { targetId } of eagerTargets) {
    if (timedOutTargets.includes(targetId)) {
      continue
    }
    try {
      const state = await window.api.ssh.getState({ targetId })
      console.warn(`[ssh-restore] Polled state for ${targetId}: status=${state?.status}`)
      if (state?.status === 'connected') {
        publishSshConnectionState(targetId, state)
      }
    } catch {
      /* best-effort */
    }
  }
}
