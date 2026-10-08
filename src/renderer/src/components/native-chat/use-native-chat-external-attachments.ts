import { useCallback, useLayoutEffect, useRef } from 'react'
import { useAppStore } from '@/store'
import { NATIVE_FILE_DROP_MAX_PATHS } from '../../../../shared/native-file-drop'
import {
  nativeChatAttachmentOwnerUnchanged,
  type NativeChatResolvedPathOptions
} from './native-chat-resolved-path-ownership'
import {
  nativeChatAttachmentOwnerChangedNotice,
  nativeChatAttachmentUnreadableNotice,
  nativeChatLocalAttachmentUnsupportedNotice,
  nativeChatTooManyAttachmentsNotice,
  nativeChatWorktreeNotReadyNotice,
  resolveNativeChatAttachmentOwner,
  resolveNativeChatAttachmentOwnerForWorktree,
  resolveNativeChatRuntimeSessionAttachmentOwner,
  uploadNativeChatAttachmentPaths,
  type NativeChatAttachmentOwner,
  type NativeChatStructuredAttachmentSession
} from './native-chat-attachment-upload'
import {
  attachNativeChatSessionAttachmentPaths,
  type NativeChatPendingAttachmentChips
} from './native-chat-session-attachment-drop'
import { userNamedFileAccess } from '@/lib/local-file-access'
import { useMountedRef } from '@/hooks/useMountedRef'
import { findTerminalTabWorktreeId } from './native-chat-file-link'

export type UseNativeChatExternalAttachmentsArgs = {
  terminalTabId: string
  structuredWorktreeId?: string
  /** The structured chat behind this composer; decides where its uploads are stored. */
  structuredSession?: NativeChatStructuredAttachmentSession
  /** Live composer-disabled state; read at await-resume via a ref so a flip
   *  mid-upload doesn't attach into a guarded composer. */
  disabled: boolean
  attachResolvedPaths: (
    paths: string[],
    connectionId?: string | null,
    options?: NativeChatResolvedPathOptions
  ) => void
  /** Chips shown while a file uploads, so Send waits for it. */
  pendingChips: NativeChatPendingAttachmentChips
  setNotice: (notice: string | null) => void
}

type ComposerWorkspace = {
  structuredWorktreeId?: string
  terminalTabId: string
  structuredSession?: NativeChatStructuredAttachmentSession
}

function isSameComposerWorkspace(captured: ComposerWorkspace, current: ComposerWorkspace): boolean {
  return (
    captured.structuredWorktreeId === current.structuredWorktreeId &&
    captured.terminalTabId === current.terminalTabId &&
    captured.structuredSession?.sessionId === current.structuredSession?.sessionId &&
    captured.structuredSession?.runtimeEnvironmentId ===
      current.structuredSession?.runtimeEnvironmentId
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
  structuredSession,
  disabled,
  attachResolvedPaths,
  pendingChips,
  setNotice
}: UseNativeChatExternalAttachmentsArgs): {
  attachExternalPaths: (paths: string[]) => void
  resolveAttachmentOwner: () => NativeChatAttachmentOwner
  captureExternalDrop: (destinationIsCurrent?: () => boolean) => (paths: string[]) => Promise<void>
} {
  const mountedRef = useMountedRef()
  const disabledRef = useRef(disabled)
  useLayoutEffect(() => {
    disabledRef.current = disabled
  }, [disabled])

  // The post-await gate asks which workspace this composer serves now, so it
  // reads the pane through a ref. Resolving through the render closure would
  // re-ask the workspace the upload started in — a comparison with itself.
  const sessionId = structuredSession?.sessionId
  const runtimeEnvironmentId = structuredSession?.runtimeEnvironmentId ?? null
  const workspaceRef = useRef<ComposerWorkspace>({
    structuredWorktreeId,
    terminalTabId,
    structuredSession
  })
  useLayoutEffect(() => {
    workspaceRef.current = {
      structuredWorktreeId,
      terminalTabId,
      structuredSession: sessionId ? { sessionId, runtimeEnvironmentId } : undefined
    }
  }, [runtimeEnvironmentId, sessionId, structuredWorktreeId, terminalTabId])
  const pendingChipsRef = useRef(pendingChips)
  useLayoutEffect(() => {
    pendingChipsRef.current = pendingChips
  }, [pendingChips])

  const resolveAttachmentOwner = useCallback(() => {
    const { structuredWorktreeId, structuredSession, terminalTabId } = workspaceRef.current
    if (structuredWorktreeId && structuredSession?.runtimeEnvironmentId) {
      return resolveNativeChatRuntimeSessionAttachmentOwner({
        sessionId: structuredSession.sessionId,
        runtimeEnvironmentId: structuredSession.runtimeEnvironmentId
      })
    }
    return structuredWorktreeId
      ? resolveNativeChatAttachmentOwnerForWorktree(useAppStore.getState(), structuredWorktreeId)
      : resolveNativeChatAttachmentOwner(useAppStore.getState(), terminalTabId)
  }, [])

  const captureExternalDrop = useCallback(
    (destinationIsCurrent: () => boolean = () => true) => {
      const owner = resolveAttachmentOwner()
      const capturedWorkspace = workspaceRef.current
      const currentWorktreeId = (): string | null =>
        workspaceRef.current.structuredWorktreeId ??
        findTerminalTabWorktreeId(
          useAppStore.getState().tabsByWorktree,
          workspaceRef.current.terminalTabId
        )
      const capturedWorktreeId = currentWorktreeId()
      const ownerStillCurrent = (): boolean =>
        // Server uploads settle into the captured scope even while its composer is unmounted.
        (owner.kind === 'runtime-session' || mountedRef.current) &&
        destinationIsCurrent() &&
        isSameComposerWorkspace(capturedWorkspace, workspaceRef.current) &&
        capturedWorktreeId === currentWorktreeId() &&
        nativeChatAttachmentOwnerUnchanged(owner, resolveAttachmentOwner())
      return async (paths: string[]): Promise<void> => {
        if (paths.length === 0 || disabledRef.current || !mountedRef.current) {
          return
        }
        if (!destinationIsCurrent()) {
          setNotice(nativeChatAttachmentOwnerChangedNotice())
          return
        }
        if (owner.kind === 'not-ready') {
          setNotice(nativeChatWorktreeNotReadyNotice())
          return
        }
        if (owner.kind === 'runtime') {
          setNotice(nativeChatLocalAttachmentUnsupportedNotice())
          return
        }
        // The picker shares the drop limit without partially attaching a batch.
        if (paths.length > NATIVE_FILE_DROP_MAX_PATHS) {
          setNotice(nativeChatTooManyAttachmentsNotice())
          return
        }
        if (!ownerStillCurrent()) {
          setNotice(nativeChatAttachmentOwnerChangedNotice())
          return
        }
        if (owner.kind === 'runtime-session') {
          await attachNativeChatSessionAttachmentPaths({
            paths,
            owner,
            chips: pendingChipsRef.current,
            isAbandoned: () => disabledRef.current,
            ownerStillCurrent,
            setNotice
          })
          return
        }
        if (owner.kind === 'ssh') {
          const remotePaths = await uploadNativeChatAttachmentPaths(paths, owner)
          if (disabledRef.current || !mountedRef.current) {
            return
          }
          if (!ownerStillCurrent()) {
            setNotice(nativeChatAttachmentOwnerChangedNotice())
            return
          }
          if (!remotePaths || remotePaths.length === 0) {
            setNotice(nativeChatAttachmentUnreadableNotice())
            return
          }
          attachResolvedPaths(remotePaths, owner.connectionId, {
            destinationIsCurrent: ownerStillCurrent
          })
          return
        }
        const readablePaths: string[] = []
        for (const targetPath of paths) {
          if (disabledRef.current || !mountedRef.current) {
            return
          }
          if (!ownerStillCurrent()) {
            setNotice(nativeChatAttachmentOwnerChangedNotice())
            return
          }
          try {
            await window.api.fs.stat({ filePath: targetPath, access: userNamedFileAccess() })
            readablePaths.push(targetPath)
          } catch {
            // Skip unreadable paths, matching workspace composer drops.
          }
        }
        if (disabledRef.current || !mountedRef.current) {
          return
        }
        if (!ownerStillCurrent()) {
          setNotice(nativeChatAttachmentOwnerChangedNotice())
          return
        }
        if (readablePaths.length === 0) {
          setNotice(nativeChatAttachmentUnreadableNotice())
          return
        }
        attachResolvedPaths(readablePaths, undefined, { destinationIsCurrent: ownerStillCurrent })
      }
    },
    [attachResolvedPaths, mountedRef, resolveAttachmentOwner, setNotice]
  )
  const attachExternalPaths = useCallback(
    (paths: string[]): void => {
      if (!disabledRef.current && mountedRef.current && paths.length > 0) {
        void captureExternalDrop()(paths)
      }
    },
    [captureExternalDrop, mountedRef]
  )

  return { attachExternalPaths, captureExternalDrop, resolveAttachmentOwner }
}
