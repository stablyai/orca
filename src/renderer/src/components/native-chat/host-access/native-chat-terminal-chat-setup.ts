import { useMemo } from 'react'
import type { RuntimeClientTarget } from '../../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import type { NativeChatImageRuntimeContext } from '../media/images/native-chat-image-runtime-context'
import { useNativeChatHostShell, type NativeChatHostSetup } from './native-chat-host-setup'

const LOCAL_TARGET: RuntimeClientTarget = { kind: 'local' }

/** A terminal-backed chat's host and workspace, so its code blocks can offer Play there; the
 *  agent's own terminal handles sign-in and install, so the chat offers neither. */
export function useNativeChatTerminalChatSetup(
  runtimeContext: NativeChatImageRuntimeContext
): NativeChatHostSetup | null {
  const target = runtimeContext?.target
  const worktreeId = runtimeContext?.worktreeId
  const shell = useNativeChatHostShell(target ?? LOCAL_TARGET)
  return useMemo(
    () =>
      target && worktreeId && shell === 'posix'
        ? { signIn: null, install: null, host: target, codeBlockWorktreeId: worktreeId }
        : null,
    [target, worktreeId, shell]
  )
}
