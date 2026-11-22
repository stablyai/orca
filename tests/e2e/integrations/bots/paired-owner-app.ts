// The owner's own Orca paired to a server. Unlike the CLI, it claims no agent caller, so the
// owner-only bot changes (create, connect Slack) go through, as from the owner's desktop or phone.
import { resolveRemoteConnection } from '../../../../src/cli/runtime/pairing/runtime-remote-pairing'
import { sendRemoteRuntimeRequestOnSocket } from '../../../../src/shared/remote-runtime/requests/remote-runtime-request-socket'

export type PairedOwnerApp = {
  call: <TResult = unknown>(method: string, params: unknown) => Promise<{ result: TResult }>
}

export function pairedOwnerApp(userDataPath: string, pairingUrl: string): PairedOwnerApp {
  const connection = resolveRemoteConnection(userDataPath, pairingUrl, null)
  return {
    call: async <TResult>(method: string, params: unknown) => {
      const remote = await connection
      if (!remote) {
        throw new Error('The pairing URL did not name a server.')
      }
      const response = await sendRemoteRuntimeRequestOnSocket<TResult>(
        remote,
        method,
        params,
        30_000
      )
      if (!response.ok) {
        throw new Error(`${method} failed: ${response.error.message}`)
      }
      return { result: response.result }
    }
  }
}
