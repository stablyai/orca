import { useCallback, useLayoutEffect, useRef } from 'react'
import { useAppStore } from '@/store'
import { nativeChatAttachmentOwnerUnchanged } from './native-chat-resolved-path-ownership'
import {
  nativeChatAttachmentOwnerChangedNotice,
  nativeChatAttachmentUnreadableNotice,
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
  attachResolvedPaths: (paths: string[], connectionId?: string | null) => void
  setNotice: (notice: string | null) => void
}

type ComposerWorkspace = { structuredWorktreeId?: string; terminalTabId: string }

function isSameComposerWorkspace(captured: ComposerWorkspace, current: ComposerWorkspace): boolean {
  return (
    captured.structuredWorktreeId === current.structuredWorktreeId &&
    captured.terminalTabId === current.terminalTabId
  )
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
  useLayoutEffect(() => {
    disabledRef.current = disabled
  }, [disabled])

  // The post-await gate asks which workspace this composer serves now, so it
  // reads the pane through a ref. Resolving through the render closure would
  // re-ask the workspace the upload started in — a comparison with itself.
  const workspaceRef = useRef<ComposerWorkspace>({ structuredWorktreeId, terminalTabId })
  useLayoutEffect(() => {
    workspaceRef.current = { structuredWorktreeId, terminalTabId }
  }, [structuredWorktreeId, terminalTabId])

  const resolveAttachmentOwner = useCallback(() => {
    const workspace = workspaceRef.current
    return workspace.structuredWorktreeId
      ? resolveNativeChatAttachmentOwnerForWorktree(
          useAppStore.getState(),
          workspace.structuredWorktreeId
        )
      : resolveNativeChatAttachmentOwner(useAppStore.getState(), workspace.terminalTabId)
  }, [])

  const attachExternalPaths = useCallback(
    (paths: string[]) => {
      if (paths.length === 0 || disabledRef.current) {
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
      // Why every exit reports: a drop that reaches here and produces nothing is
      // the silent-failure complaint in #15782. Only a disabled composer stays
      // quiet — it is being torn down or guarded, and has no notice surface.
      const capturedWorkspace = workspaceRef.current
      // Both halves matter: a moved tab can land on a workspace that reports the
      // same owner kind, and the owner alone would call that unchanged.
      const ownerStillCurrent = (): boolean =>
        isSameComposerWorkspace(capturedWorkspace, workspaceRef.current) &&
        nativeChatAttachmentOwnerUnchanged(owner, resolveAttachmentOwner())
      if (owner.kind !== 'ssh') {
        void (async () => {
          const authorizedPaths: string[] = []
          for (const targetPath of paths) {
            if (disabledRef.current) {
              return
            }
            if (!ownerStillCurrent()) {
              setNotice(nativeChatAttachmentOwnerChangedNotice())
              return
            }
            try {
              try {
                await window.api.fs.grantExternalFile({ targetPath })
              } catch {
                await window.api.fs.grantExternalDirectory({ targetPath })
              }
              authorizedPaths.push(targetPath)
            } catch {
              // Skip unreadable paths, matching workspace composer drops.
            }
          }
          if (disabledRef.current) {
            return
          }
          if (!ownerStillCurrent()) {
            setNotice(nativeChatAttachmentOwnerChangedNotice())
            return
          }
          if (authorizedPaths.length === 0) {
            setNotice(nativeChatAttachmentUnreadableNotice())
            return
          }
          attachResolvedPaths(authorizedPaths)
        })()
        return
      }
      void (async () => {
        const remotePaths = await uploadNativeChatAttachmentPaths(paths, owner)
        if (disabledRef.current) {
          return
        }
        if (!remotePaths || remotePaths.length === 0) {
          // uploadNativeChatAttachmentPaths already toasted the IPC failure;
          // an empty result with no failure means nothing was readable.
          setNotice(nativeChatAttachmentUnreadableNotice())
          return
        }
        if (!ownerStillCurrent()) {
          setNotice(nativeChatAttachmentOwnerChangedNotice())
          return
        }
        attachResolvedPaths(remotePaths, owner.connectionId)
      })()
    },
    [attachResolvedPaths, resolveAttachmentOwner, setNotice]
  )

  return { attachExternalPaths, resolveAttachmentOwner }
}
