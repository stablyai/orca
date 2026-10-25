import type { NativeChatSessionOptionSettingsMutation } from '../../../../shared/native-chat-session-options'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'

/** Apply deltas at the owning runtime so desktop/mobile choices cannot replace each other’s records. */
export function enqueueSessionOptionSettingsWrite(
  target: RuntimeClientTarget,
  mutation: NativeChatSessionOptionSettingsMutation
): Promise<void> {
  return callRuntimeRpc(target, 'settings.mutateNativeChatSessionOptions', mutation)
    .then(() => undefined)
    .catch(() => undefined)
}
