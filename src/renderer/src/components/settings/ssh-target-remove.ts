export type SshTargetRemoveApi = {
  terminateSessions: (args: { targetId: string }) => Promise<unknown>
  removeTarget: (args: { id: string }) => Promise<unknown>
}

// Why: terminating remote PTYs is best-effort cleanup of the grace window.
// If the server is unreachable (dead host, blocked port, expired credentials),
// the host's reconnect-before-terminate hangs on the handshake and the user is
// stuck with a target they cannot delete (issue #2626). Local removal must
// always succeed; the relay layer disposes any live session on its own side.
export async function removeSshTargetWithBestEffortCleanup(
  api: SshTargetRemoveApi,
  id: string
): Promise<void> {
  try {
    await api.terminateSessions({ targetId: id })
  } catch (err) {
    console.warn(
      '[ssh] Skipping remote session cleanup during target removal:',
      err instanceof Error ? err.message : String(err)
    )
  }
  await api.removeTarget({ id })
}
