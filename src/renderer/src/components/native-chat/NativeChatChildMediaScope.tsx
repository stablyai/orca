import { useMemo, type ReactNode } from 'react'
import { useAppStore } from '@/store'
import { resolveWorkspaceDirectory } from '@/lib/workspace-directory'
import type { RuntimeFileOperationArgs } from '@/runtime/runtime-file-client-types'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import { toRuntimeExecutionHostId } from '../../../../shared/execution-host'
import { NativeChatMarkdownImageOwnerContext } from './native-chat-markdown-image-owner'
import {
  NativeChatVisualOwnerContext,
  type NativeChatVisualOwner
} from './native-chat-visual-owner'

export function NativeChatChildMediaScope({
  target,
  runtimeContext,
  sessionId,
  isVisible,
  children
}: {
  target?: RuntimeClientTarget
  runtimeContext?: RuntimeFileOperationArgs | null
  sessionId: string | null
  isVisible: boolean
  children: ReactNode
}): React.JSX.Element {
  const worktreeId = runtimeContext?.worktreeId
  const hostId =
    target?.kind === 'environment' ? toRuntimeExecutionHostId(target.environmentId) : 'local'
  const directory = useAppStore((state) =>
    target && worktreeId ? resolveWorkspaceDirectory(state, worktreeId, hostId) : null
  )
  const imageOwner = useMemo(
    () =>
      target && worktreeId && directory && sessionId && runtimeContext
        ? {
            fileLinkContext: {
              worktreeId,
              worktreePath: directory,
              runtimeEnvironmentId: target.kind === 'environment' ? target.environmentId : null
            },
            runtimeContext: { ...runtimeContext, target, worktreePath: directory },
            isVisible,
            sessionId
          }
        : null,
    [target, worktreeId, directory, sessionId, runtimeContext, isVisible]
  )
  const visualOwner = useMemo<NativeChatVisualOwner | null>(
    () =>
      imageOwner && target && sessionId && worktreeId ? { target, sessionId, worktreeId } : null,
    [imageOwner, target, sessionId, worktreeId]
  )
  return (
    <NativeChatVisualOwnerContext.Provider value={visualOwner}>
      <NativeChatMarkdownImageOwnerContext.Provider value={imageOwner}>
        {children}
      </NativeChatMarkdownImageOwnerContext.Provider>
    </NativeChatVisualOwnerContext.Provider>
  )
}
