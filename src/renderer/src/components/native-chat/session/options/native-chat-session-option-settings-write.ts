import type { NativeChatSessionOptionSettingsMutation } from '../../../../../../shared/native-chat/input/native-chat-session-options'
import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'
import { RuntimeRpcCallError } from '@/runtime/rpc/calls/runtime-rpc-result'
import type { RuntimeClientTarget } from '../../../../../../shared/remote-runtime/host-catalog/runtime-client-target'

/** Apply deltas at the owning runtime so desktop/mobile choices cannot replace each other’s records. */
export function enqueueSessionOptionSettingsWrite(
  target: RuntimeClientTarget,
  mutation: NativeChatSessionOptionSettingsMutation,
  options: { expectedEnvironmentPairingRevision?: number } = {}
): Promise<void> {
  const write = (next: NativeChatSessionOptionSettingsMutation) =>
    callRuntimeRpc(target, 'settings.mutateNativeChatSessionOptions', next, options)
  return write(mutation)
    .catch((error: unknown) => {
      // COMPAT: a host from before picks named their chat refuses the field; it keeps them as chat picks.
      if (
        mutation.type === 'apply-picks' &&
        mutation.sessionId !== undefined &&
        error instanceof RuntimeRpcCallError &&
        error.code === 'invalid_argument'
      ) {
        const { sessionId: _sessionId, ...withoutSession } = mutation
        return write(withoutSession)
      }
      throw error
    })
    .then(() => undefined)
    .catch(() => undefined)
}
