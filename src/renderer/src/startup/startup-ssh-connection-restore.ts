import type { SshConnectionState } from '../../../shared/ssh-types'
import { timeRendererStartupStep } from './startup-diagnostics'
import { reconnectSshTargetForRendererStartup } from './ssh-startup-reconnect'

const SSH_RECONNECT_TIMEOUT_MS = 15_000

/**
 * Re-establishes the SSH targets that were live at shutdown before terminal reconnect, so
 * SSH-backed tabs route through pty.attach. Passphrase-protected and timed-out targets are
 * handed back as deferred so their PTYs reattach on tab focus instead of stacking dialogs.
 */
export async function restoreSshConnectionsForStartup(args: {
  connectionIds: string[]
  setDeferredSshReconnectTargets: (targetIds: string[]) => void
  publishSshConnectionState: (targetId: string, state: SshConnectionState) => void
}): Promise<void> {
  const { connectionIds, setDeferredSshReconnectTargets, publishSshConnectionState } = args
  const allTargets = await timeRendererStartupStep('ssh-list-targets', () =>
    window.api.ssh.listTargets()
  )
  const targetMap = new Map(allTargets.map((t) => [t.id, t]))
  const targets = connectionIds.map((targetId) => ({
    targetId,
    needsPassphrase: targetMap.get(targetId)?.lastRequiredPassphrase ?? false
  }))

  const eagerTargets = targets.filter((t) => !t.needsPassphrase)
  const deferredTargets = targets.filter((t) => t.needsPassphrase)

  if (deferredTargets.length > 0) {
    setDeferredSshReconnectTargets(deferredTargets.map((t) => t.targetId))
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
    { eagerTargets: eagerTargets.length, deferredTargets: deferredTargets.length }
  )
  if (timedOutTargets.length > 0) {
    setDeferredSshReconnectTargets([...deferredTargets.map((t) => t.targetId), ...timedOutTargets])
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
