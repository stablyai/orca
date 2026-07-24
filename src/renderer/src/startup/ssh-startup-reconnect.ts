import type { SshConnectionState } from '../../../shared/ssh-types'
import { mapWithConcurrency } from '../../../shared/map-with-concurrency'

const SSH_STARTUP_RECONNECT_CONCURRENCY = 4

export type SshStartupReconnectResult = {
  timedOut: boolean
}

export async function reconnectSshTargetForRendererStartup(args: {
  targetId: string
  timeoutMs: number
  connect: (targetId: string) => Promise<SshConnectionState | null>
  publishState: (targetId: string, state: SshConnectionState) => void
  onFailure: (targetId: string, error: unknown) => void
}): Promise<SshStartupReconnectResult> {
  const { targetId, timeoutMs, connect, publishState, onFailure } = args
  let timeoutId: ReturnType<typeof setTimeout> | null = null
  try {
    const timeout = new Promise<never>((_resolve, reject) => {
      timeoutId = setTimeout(() => reject(new Error('SSH reconnect timeout')), timeoutMs)
    })
    const state = await Promise.race([connect(targetId), timeout])
    // Why: the state-change IPC can trail connect's resolution. Publish the
    // authoritative result before restored terminals inspect renderer state.
    if (state) {
      publishState(targetId, state)
    }
    return { timedOut: false }
  } catch (error) {
    onFailure(targetId, error)
    return {
      timedOut: error instanceof Error && error.message === 'SSH reconnect timeout'
    }
  } finally {
    if (timeoutId !== null) {
      clearTimeout(timeoutId)
    }
  }
}

export async function reconnectSshTargetsForRendererStartup(args: {
  targetIds: readonly string[]
  timeoutMs: number
  connect: (targetId: string) => Promise<SshConnectionState | null>
  publishState: (targetId: string, state: SshConnectionState) => void
  onFailure: (targetId: string, error: unknown) => void
}): Promise<string[]> {
  const { targetIds, timeoutMs, connect, publishState, onFailure } = args
  // Why: batching must not multiply the existing startup wait ceiling.
  const deadline = Date.now() + timeoutMs
  const results = await mapWithConcurrency(
    targetIds,
    SSH_STARTUP_RECONNECT_CONCURRENCY,
    async (targetId) => {
      const remainingMs = deadline - Date.now()
      if (remainingMs <= 0) {
        onFailure(targetId, new Error('SSH reconnect timeout'))
        return targetId
      }
      const result = await reconnectSshTargetForRendererStartup({
        targetId,
        timeoutMs: remainingMs,
        connect,
        publishState,
        onFailure
      })
      return result.timedOut ? targetId : null
    }
  )
  return results.filter((targetId): targetId is string => targetId !== null)
}
