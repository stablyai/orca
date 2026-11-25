import { createContext, useMemo } from 'react'
import {
  useNativeChatImageRuntimeContext,
  type NativeChatImageRuntimeContext
} from './native-chat-image-runtime-context'
import { useNativeChatFileLinkContext } from '../../links/actions/use-native-chat-file-link-context'
import { runtimeTargetEnvironmentId } from '@/runtime/rpc/targets/runtime-client-target'
import type { NativeChatFileLinkContext } from '../../links/actions/native-chat-file-link-context'

export type NativeChatMarkdownImageOwner = {
  fileLinkContext: NativeChatFileLinkContext | null
  runtimeContext: NativeChatImageRuntimeContext
  isVisible: boolean
  sessionId?: string | null
}

export const NativeChatMarkdownImageOwnerContext =
  createContext<NativeChatMarkdownImageOwner | null>(null)

export function useNativeChatTabMarkdownImageOwner(
  tabId: string,
  isVisible: boolean,
  sessionId: string | null
): NativeChatMarkdownImageOwner {
  const fileLinkContext = useNativeChatFileLinkContext(tabId)
  const runtimeContext = useNativeChatImageRuntimeContext(tabId)
  return useMemo(
    () => ({ fileLinkContext, runtimeContext, isVisible, sessionId }),
    [fileLinkContext, runtimeContext, isVisible, sessionId]
  )
}

/** How an image's file opens: paths resolve where its bytes are read, but it opens in the
 *  transcript's own workspace. A group member's folder is only a path base, never a destination. */
export function nativeChatImageFileLinkContext(
  owner: NativeChatMarkdownImageOwner | null
): NativeChatFileLinkContext | null {
  const runtimeContext = owner?.runtimeContext
  const fileLinkContext = owner?.fileLinkContext
  if (!runtimeContext?.worktreePath || !fileLinkContext) {
    return null
  }
  if (runtimeContext.worktreeId && runtimeContext.worktreeId !== fileLinkContext.worktreeId) {
    return { ...fileLinkContext, pathBase: runtimeContext.worktreePath }
  }
  return {
    ...fileLinkContext,
    worktreePath: runtimeContext.worktreePath,
    runtimeEnvironmentId: runtimeTargetEnvironmentId(runtimeContext.target)
  }
}
