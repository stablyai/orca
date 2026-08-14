import { settingsForRuntimeOwner } from '@/runtime/runtime-rpc-client'
import type { NativeChatFileLinkContext } from './native-chat-file-link'
import type { NativeChatImageLoadContext } from './NativeChatImageAttachments'

export function nativeChatImageLoadContext(
  context: NativeChatFileLinkContext | null
): NativeChatImageLoadContext {
  return context
    ? {
        runtimeContext: {
          settings: settingsForRuntimeOwner(undefined, context.runtimeEnvironmentId),
          worktreeId: context.worktreeId,
          worktreePath: context.worktreePath
        }
      }
    : { disabled: true }
}
