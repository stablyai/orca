import { SSH_TERMINATE_RECONNECT_REQUIRED } from '../../../../shared/constants'

export async function terminateSshSessionsWithReconnect(targetId: string): Promise<void> {
  try {
    await window.api.ssh.terminateSessions({ targetId })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (!message.includes(SSH_TERMINATE_RECONNECT_REQUIRED)) {
      throw err
    }
    // Why: disconnect is now non-destructive, so preserved remote PTYs may
    // require a fresh relay attachment before they can be explicitly killed.
    await window.api.ssh.connect({ targetId })
    await window.api.ssh.terminateSessions({ targetId })
  }
}
