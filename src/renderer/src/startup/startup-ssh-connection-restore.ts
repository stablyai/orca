import type { SshConnectionState } from '../../../shared/ssh-types'
import { timeRendererStartupStep } from './startup-diagnostics'
import { reconnectSshTargetForRendererStartup } from './ssh-startup-reconnect'

const SSH_RECONNECT_TIMEOUT_MS = 15_000

/** Reconnect prior live SSH targets before terminal attach. Await only blockingConnectionIds; defer background/passphrase/timed-out hosts for focus reattach without stacked dialogs. Main’s connects continue and focused panes join the same in-flight request. */
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
  // Opted-out hosts stay disconnected like hosts that were off at quit; their panes offer Connect.
  const targets = connectionIds
    .filter((targetId) => targetMap.get(targetId)?.reconnectOnLaunch !== false)
    .map((targetId) => ({
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

  // Track connected targets so timeout’s whole-list rewrite cannot redefer successful background hosts.
  const connectedBackgroundTargetIds = new Set<string>()
  // Start background connects before awaited group so early successes restore as ordinary connected targets.
  for (const { targetId } of backgroundTargets) {
    void reconnectSshTargetForRendererStartup({
      targetId,
      connect: (id) => window.api.ssh.connect({ targetId: id, automatic: true }),
      publishState: (id, state) => {
        publishSshConnectionState(id, state)
        if (state.status === 'connected') {
          // Clear deferral as soon as reachable or fresh panes take deferred spawn instead of normal restoration.
          connectedBackgroundTargetIds.add(id)
          removeDeferredSshReconnectTarget(id)
        }
      },
      onFailure: (id, error) => {
        console.warn(`SSH background auto-reconnect failed for ${id}:`, error)
      }
    })
  }

  // Timed-out connects continue in main; defer their PTY attach until focus.
  const timedOutTargets: string[] = []
  await timeRendererStartupStep(
    'ssh-reconnect',
    () =>
      Promise.all(
        eagerTargets.map(async ({ targetId }) => {
          const result = await reconnectSshTargetForRendererStartup({
            targetId,
            timeoutMs: SSH_RECONNECT_TIMEOUT_MS,
            connect: (id) => window.api.ssh.connect({ targetId: id, automatic: true }),
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

  // Older/wrapped connect providers omit state; poll main once before restore for compatibility.
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
