import type { NativeChatSessionOptionSettingsMutation } from '../../../../shared/native-chat-session-options'
import { callRuntimeRpc, type RuntimeClientTarget } from '@/runtime/runtime-rpc-client'

/**
 * Remember picker choices on the client's settings owner, including choices made in SSH chats.
 */
export function enqueueSessionOptionSettingsWrite(
  _target: RuntimeClientTarget,
  mutation: NativeChatSessionOptionSettingsMutation
): Promise<void> {
  return callRuntimeRpc({ kind: 'local' }, 'settings.mutateNativeChatSessionOptions', mutation)
    .then(() => undefined)
    .catch(() => undefined)
}
