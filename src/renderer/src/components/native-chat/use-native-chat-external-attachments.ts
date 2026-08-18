import { useCallback, useRef } from 'react'
import { useAppStore } from '@/store'
import {
  nativeChatLocalAttachmentUnsupportedNotice,
  nativeChatWorktreeNotReadyNotice,
  resolveNativeChatAttachmentOwner,
  resolveNativeChatAttachmentOwnerForWorktree,
  uploadNativeChatAttachmentPaths,
  type NativeChatAttachmentOwner
} from './native-chat-attachment-upload'

export type UseNativeChatExternalAttachmentsArgs = {
  terminalTabId: string
  structuredWorktreeId?: string
  /** Live composer-disabled state; read at await-resume via a ref so a flip
   *  mid-upload doesn't attach into a guarded composer. */
  disabled: boolean
  attachResolvedPaths: (paths: string[]) => void
  setNotice: (notice: string | null) => void
}

/**
 * Attach paths that arrived client-local (composer drop / file picker). SSH
 * worktrees upload into the worktree's `.orca/drops` first so the remote agent
 * can actually read what gets referenced (STA-1465).
 */
export function useNativeChatExternalAttachments({
  terminalTabId,
  structuredWorktreeId,
  disabled,
  attachResolvedPaths,
  setNotice
}: UseNativeChatExternalAttachmentsArgs): {
  attachExternalPaths: (paths: string[]) => void
  resolveAttachmentOwner: () => NativeChatAttachmentOwner
} {
  const disabledRef = useRef(disabled)
  disabledRef.current = disabled

  const resolveAttachmentOwner = useCallback(
    () =>
      structuredWorktreeId
        ? resolveNativeChatAttachmentOwnerForWorktree(useAppStore.getState(), structuredWorktreeId)
        : resolveNativeChatAttachmentOwner(useAppStore.getState(), terminalTabId),
    [structuredWorktreeId, terminalTabId]
  )

  const attachExternalPaths = useCallback(
    (paths: string[]) => {
      if (paths.length === 0) {
        return
      }
      const owner = resolveAttachmentOwner()
      if (owner.kind === 'not-ready') {
        setNotice(nativeChatWorktreeNotReadyNotice())
        return
      }
      if (owner.kind === 'runtime') {
        setNotice(nativeChatLocalAttachmentUnsupportedNotice())
        return
      }
      if (owner.kind !== 'ssh') {
        attachResolvedPaths(paths)
        return
      }
      void (async () => {
        const remotePaths = await uploadNativeChatAttachmentPaths(paths, owner)
        if (!remotePaths || remotePaths.length === 0 || disabledRef.current) {
          return
        }
        attachResolvedPaths(remotePaths)
      })()
    },
    [attachResolvedPaths, resolveAttachmentOwner, setNotice]
  )

  return { attachExternalPaths, resolveAttachmentOwner }
}
