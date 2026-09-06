import type { SshConnectionState } from '../../../shared/ssh-types'

export type SshStartupReconnectResult = {
  timedOut: boolean
}

export async function reconnectSshTargetForRendererStartup(args: {
  targetId: string
  /** Omitted for a connect nobody is waiting on — no timer, so it cannot report
   *  a timeout the caller has no use for. */
  timeoutMs?: number
  connect: (targetId: string) => Promise<SshConnectionState | null>
  publishState: (targetId: string, state: SshConnectionState) => void
  onFailure: (targetId: string, error: unknown) => void
}): Promise<SshStartupReconnectResult> {
  const { targetId, timeoutMs, connect, publishState, onFailure } = args
  let timeoutId: ReturnType<typeof setTimeout> | null = null
  try {
    const connected = connect(targetId)
    const state =
      timeoutMs === undefined
        ? await connected
        : await Promise.race([
            connected,
            new Promise<never>((_resolve, reject) => {
              timeoutId = setTimeout(() => reject(new Error('SSH reconnect timeout')), timeoutMs)
            })
          ])
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
