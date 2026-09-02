import type { SshConnectionState } from '../../../shared/ssh-types'

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
