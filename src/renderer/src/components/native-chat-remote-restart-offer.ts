import type { RuntimeEnvironmentStatus } from '../../../shared/runtime-host-status'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import type { HostOfferRead } from './native-chat-restart-host-offer'

export const RESTART_READ_RETRY_DELAYS_MS = [100, 250, 500] as const

export async function readDesktopCreatedChatIds(
  target: RuntimeClientTarget,
  offer: HostOfferRead,
  previous: Set<string> | null,
  refresh: boolean
): Promise<Set<string> | null> {
  if (target.kind === 'local' || offer.candidates.length + offer.failed.length === 0) {
    return null
  }
  if (previous !== null && !refresh) {
    return previous
  }
  try {
    return new Set((await window.api.runtimeEnvironments.desktopCreatedChatIds?.()) ?? [])
  } catch {
    return new Set()
  }
}

export function remoteRestartRuntimeId(status: RuntimeEnvironmentStatus | undefined) {
  const snapshot = status?.snapshot
  const verified = snapshot
    ? snapshot.verification === 'verified' && snapshot.transport === 'ready'
    : !!status?.status
  return verified ? status?.status?.runtimeId : undefined
}

/** Contact attempts belong to one occurrence; only a confirmed observation spends its first offer. */
export function createRemoteRestartOfferLifecycle({
  read,
  requestDialog,
  currentAction
}: {
  read: (current: () => boolean) => Promise<HostOfferRead>
  requestDialog: () => void
  currentAction: () => number
}) {
  let readyKey: string | undefined
  let observed = false
  let attempt: object | undefined
  let cancelWait: (() => void) | undefined
  function cancel() {
    attempt = undefined
    cancelWait?.()
    cancelWait = undefined
  }
  async function discover() {
    const token = (attempt = {})
    const issued = currentAction()
    const current = () => attempt === token && currentAction() === issued
    for (const delay of [0, ...RESTART_READ_RETRY_DELAYS_MS]) {
      if (delay) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, delay)
          cancelWait = () => {
            clearTimeout(timer)
            resolve()
          }
        })
      }
      if (!current()) {
        return
      }
      const answer = await read(current)
      if (!current()) {
        return
      }
      if (answer.available) {
        if (!observed && answer.candidates.length > 0) {
          requestDialog()
        }
        observed = true
        return
      }
    }
  }
  return {
    dispose: cancel,
    observeRuntimeStatus: (status: RuntimeEnvironmentStatus | undefined) => {
      const id = remoteRestartRuntimeId(status)
      const nextKey = id ? `${id}:${status?.hostContactEpoch ?? 0}` : undefined
      if (nextKey === readyKey) {
        return
      }
      readyKey = nextKey
      cancel()
      if (id) {
        void discover()
      }
    }
  }
}
