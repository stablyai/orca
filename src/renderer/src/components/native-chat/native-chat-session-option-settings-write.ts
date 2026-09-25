import type { NativeChatSessionOptionSettingsMutation } from '../../../../shared/native-chat-session-options'
import { callRuntimeRpc, type RuntimeClientTarget } from '@/runtime/runtime-rpc-client'

/**
 * The executing runtime applies deltas to its latest record. This keeps paired-runtime
 * choices on their owner and prevents desktop/mobile writes from replacing one another.
 */
export function enqueueSessionOptionSettingsWrite(
  target: RuntimeClientTarget,
  mutation: NativeChatSessionOptionSettingsMutation
): Promise<void> {
  return callRuntimeRpc(target, 'settings.mutateNativeChatSessionOptions', mutation)
    .then(() => undefined)
    .catch(() => undefined)
}
