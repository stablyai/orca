import { SSH_TERMINATE_RECONNECT_REQUIRED } from '../../../../shared/constants'

export type SshTargetRemoveApi = {
  terminateSessions: (args: { targetId: string }) => Promise<unknown>
  connect: (args: { targetId: string }) => Promise<unknown>
  removeTarget: (args: { id: string }) => Promise<unknown>
}

// Why: terminating remote PTYs is best-effort cleanup of the grace window.
// If the server is unreachable (dead host, blocked port, expired credentials),
// the reconnect-before-terminate path hangs on the handshake and the user is
// stuck with a target they cannot delete (issue #2626). Local removal must
// always succeed; the relay layer disposes any live session on its own side.
export async function removeSshTargetWithBestEffortCleanup(
  api: SshTargetRemoveApi,
  id: string
): Promise<void> {
  try {
    await api.terminateSessions({ targetId: id })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (message.includes(SSH_TERMINATE_RECONNECT_REQUIRED)) {
      try {
        await api.connect({ targetId: id })
        await api.terminateSessions({ targetId: id })
      } catch (reconnectErr) {
        console.warn(
          '[ssh] Skipping remote session cleanup during target removal:',
          reconnectErr instanceof Error ? reconnectErr.message : String(reconnectErr)
        )
      }
    } else {
      console.warn('[ssh] Skipping remote session cleanup during target removal:', message)
    }
  }
  await api.removeTarget({ id })
}
