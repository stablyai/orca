import { useCallback, useLayoutEffect, useRef } from 'react'
import { useAppStore } from '@/store'
import { NATIVE_FILE_DROP_MAX_PATHS } from '../../../../shared/native-file-drop'
import {
  nativeChatAttachmentOwnerUnchanged,
  type NativeChatAttachmentFocusOptions,
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
  type NativeChatAttachmentOwner,
  type NativeChatStructuredAttachmentSession
} from './native-chat-attachment-upload'
import {
  attachNativeChatSessionAttachmentPaths,
  reserveNativeChatAttachmentChips,
  type NativeChatPendingAttachmentChips,
  type NativeChatReservedAttachment
} from './native-chat-session-attachment-drop'
import { userNamedFileAccess } from '@/lib/local-file-access'
import { useMountedRef } from '@/hooks/useMountedRef'
import { findTerminalTabWorktreeId } from './native-chat-file-link'
import { isNativeChatImageAttachmentPath } from './native-chat-image-paste'
import type { CapturedNativeChatDrop } from './native-chat-pane-file-drop'

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
  attachExternalPaths: (paths: string[], options?: NativeChatAttachmentFocusOptions) => void
  resolveAttachmentOwner: () => NativeChatAttachmentOwner
  captureExternalDrop: (
    destinationIsCurrent?: () => boolean,
    options?: NativeChatAttachmentFocusOptions
  ) => CapturedNativeChatDrop
  captureReservedAttachments: (
    destinationIsCurrent?: () => boolean,
    options?: NativeChatAttachmentFocusOptions
  ) => (reserved: NativeChatReservedAttachment[]) => Promise<void>
} {
  const mountedRef = useMountedRef()
  const disabledRef = useRef(disabled)
  useLayoutEffect(() => {
    disabledRef.current = disabled
  }, [disabled])

  // The post-await gate asks which workspace this composer serves now, so it
  // reads the pane through a ref. Resolving through the render closure would
  // re-ask the workspace the upload started in — a comparison with itself.
  const workspaceRef = useRef<ComposerWorkspace>({
    structuredWorktreeId,
    terminalTabId,
    structuredSession
  })
  useLayoutEffect(() => {
    workspaceRef.current = { structuredWorktreeId, terminalTabId, structuredSession }
  }, [structuredSession, structuredWorktreeId, terminalTabId])
  const pendingChipsRef = useRef(pendingChips)
  useLayoutEffect(() => {
    pendingChipsRef.current = pendingChips
  }, [pendingChips])

  const resolveAttachmentOwner = useCallback((): NativeChatAttachmentOwner => {
    const { structuredWorktreeId, structuredSession, terminalTabId } = workspaceRef.current
    if (structuredWorktreeId && structuredSession?.runtimeEnvironmentId) {
      if (structuredSession.sessionPending) {
        return { kind: 'not-ready', notice: structuredSession.sessionPendingNotice }
      }
      return resolveNativeChatRuntimeSessionAttachmentOwner({
        sessionId: structuredSession.sessionId,
        runtimeEnvironmentId: structuredSession.runtimeEnvironmentId
      })
    }
    if (!structuredWorktreeId) {
      return resolveNativeChatAttachmentOwner(useAppStore.getState(), terminalTabId)
    }
    const owner = resolveNativeChatAttachmentOwnerForWorktree(
      useAppStore.getState(),
      structuredWorktreeId
    )
    return owner.kind === 'local' && structuredSession
      ? { kind: 'local', structuredSessionId: structuredSession.sessionId }
      : owner
  }, [])

  // Captures one intake's owner, destination and chips; its checks and work run against them later.
  const captureIntake = useCallback(
    (destinationIsCurrent: () => boolean, options?: NativeChatAttachmentFocusOptions) => {
      const owner = resolveAttachmentOwner()
      const chips = pendingChipsRef.current
      const capturedWorkspace = workspaceRef.current
      const currentWorktreeId = (): string | null =>
        workspaceRef.current.structuredWorktreeId ??
        findTerminalTabWorktreeId(
          useAppStore.getState().tabsByWorktree,
          workspaceRef.current.terminalTabId
        )
      const capturedWorktreeId = currentWorktreeId()
      const ownerStillCurrent = (): boolean =>
        destinationIsCurrent() &&
        isSameComposerWorkspace(capturedWorkspace, workspaceRef.current) &&
        capturedWorktreeId === currentWorktreeId() &&
        nativeChatAttachmentOwnerUnchanged(owner, resolveAttachmentOwner())
      const refusal = (count: number): string | null => {
        if (!destinationIsCurrent()) {
          return nativeChatAttachmentOwnerChangedNotice()
        }
        if (owner.kind === 'not-ready') {
          return owner.notice ?? nativeChatWorktreeNotReadyNotice()
        }
        if (owner.kind === 'remote') {
          return nativeChatLocalAttachmentUnsupportedNotice()
        }
        // The picker shares the drop limit without partially attaching a batch.
        if (count > NATIVE_FILE_DROP_MAX_PATHS) {
          return nativeChatTooManyAttachmentsNotice()
        }
        return ownerStillCurrent() ? null : nativeChatAttachmentOwnerChangedNotice()
      }
      const run = async (reserved: NativeChatReservedAttachment[]): Promise<void> => {
        if (owner.kind === 'runtime-session') {
          await attachNativeChatSessionAttachmentPaths({
            pending: reserved,
            owner,
            chips,
            options,
            isAbandoned: () => disabledRef.current,
            ownerStillCurrent,
            setNotice
          })
          return
        }
        const pending = [...reserved]
        try {
          if (pending.length === 0) {
            return
          }
          const readable: typeof pending = []
          for (const entry of pending) {
            if (disabledRef.current) {
              return
            }
            if (!ownerStillCurrent()) {
              setNotice(nativeChatAttachmentOwnerChangedNotice())
              return
            }
            try {
              await window.api.fs.stat({ filePath: entry.path, access: userNamedFileAccess() })
              readable.push(entry)
            } catch {
              // Skip unreadable paths, matching workspace composer drops.
              chips.drop(entry.chipId)
            }
          }
          if (disabledRef.current) {
            return
          }
          if (!ownerStillCurrent()) {
            setNotice(nativeChatAttachmentOwnerChangedNotice())
            return
          }
          if (readable.length === 0) {
            setNotice(nativeChatAttachmentUnreadableNotice())
            return
          }
          const prepared = pending.splice(0)
          attachResolvedPaths(
            readable.map(({ path }) => path),
            undefined,
            {
              ...options,
              destinationIsCurrent: ownerStillCurrent,
              operation: {
                apply: (insertReferences) => {
                  const completion = { focus: false, insertReferences }
                  let attached = false
                  for (const { path, chipId } of readable) {
                    attached =
                      (isNativeChatImageAttachmentPath(path)
                        ? chips.resolve(chipId, path, undefined, completion)
                        : chips.attachReferences([{ id: chipId, path }], completion)) || attached
                  }
                  return attached
                },
                cancel: () => prepared.forEach(({ chipId }) => chips.drop(chipId))
              }
            }
          )
        } catch {
          setNotice(nativeChatAttachmentUnreadableNotice())
        } finally {
          for (const { chipId } of pending) {
            chips.drop(chipId)
          }
        }
      }
      return {
        chips,
        refusal,
        run,
        preparationConsumer:
          owner.kind === 'local' && owner.structuredSessionId
            ? ('local-chat' as const)
            : ('agent' as const)
      }
    },
    [attachResolvedPaths, resolveAttachmentOwner, setNotice]
  )

  const captureExternalDrop = useCallback(
    (
      destinationIsCurrent: () => boolean = () => true,
      options?: NativeChatAttachmentFocusOptions
    ) => {
      const intake = captureIntake(destinationIsCurrent, options)
      const deliver: CapturedNativeChatDrop = async (paths: string[]): Promise<void> => {
        if (paths.length === 0 || disabledRef.current || !mountedRef.current) {
          return
        }
        const notice = intake.refusal(paths.length)
        if (notice) {
          setNotice(notice)
          return
        }
        await intake.run(reserveNativeChatAttachmentChips(intake.chips, paths))
      }
      deliver.preparationConsumer = intake.preparationConsumer
      return deliver
    },
    [captureIntake, mountedRef, setNotice]
  )

  // Chips a paste reserved before its clipboard said they are files: admitted work, so it may
  // finish after an unmount; a refusal releases them.
  const captureReservedAttachments = useCallback(
    (
      destinationIsCurrent: () => boolean = () => true,
      options?: NativeChatAttachmentFocusOptions
    ) => {
      const intake = captureIntake(destinationIsCurrent, options)
      return async (reserved: NativeChatReservedAttachment[]): Promise<void> => {
        if (reserved.length === 0) {
          return
        }
        const notice = disabledRef.current ? '' : intake.refusal(reserved.length)
        if (notice === null) {
          await intake.run(reserved)
          return
        }
        reserved.forEach(({ chipId }) => intake.chips.drop(chipId))
        if (notice) {
          setNotice(notice)
        }
      }
    },
    [captureIntake, setNotice]
  )
  const attachExternalPaths = useCallback(
    (paths: string[], options?: NativeChatAttachmentFocusOptions): void => {
      if (!disabledRef.current && mountedRef.current && paths.length > 0) {
        void captureExternalDrop(undefined, options)(paths)
      }
    },
    [captureExternalDrop, mountedRef]
  )

  return {
    attachExternalPaths,
    captureExternalDrop,
    captureReservedAttachments,
    resolveAttachmentOwner
  }
}
