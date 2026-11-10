import { captureNativeChatEditDraftDestination } from '../../drafts/native-chat-composer-draft-memory'
import { useCallback, useLayoutEffect, useRef } from 'react'
import { useAppStore } from '@/store'
import { NATIVE_FILE_DROP_MAX_PATHS } from '../../../../../../shared/file-import/native-file-drop'
import {
  isSameComposerWorkspace,
  nativeChatAttachmentOwnerUnchanged,
  type ComposerWorkspace,
  type NativeChatAttachmentFocusOptions,
  type NativeChatResolvedPathOptions
} from '../uploads/native-chat-resolved-path-ownership'
import {
  nativeChatAttachmentOwnerChangedNotice,
  nativeChatTooManyAttachmentsNotice,
  nativeChatWorktreeNotReadyNotice,
  nativeChatLocalAttachmentUnsupportedNotice
} from './native-chat-attachment-notices'
import {
  resolveNativeChatAttachmentOwner,
  resolveNativeChatAttachmentOwnerForWorktree,
  resolveNativeChatRuntimeSessionAttachmentOwner,
  type NativeChatAttachmentOwner,
  type NativeChatStructuredAttachmentSession
} from '../uploads/native-chat-attachment-owner'

import {
  attachNativeChatSessionAttachmentPaths,
  reserveNativeChatAttachmentChips,
  type NativeChatPendingAttachmentChips,
  type NativeChatReservedAttachment
} from './native-chat-session-attachment-drop'
import { releaseBrowserAttachmentFiles } from '@/lib/files/drop/browser-attachment-files'
import { attachNativeChatLocalAttachmentPaths } from './native-chat-local-attachment-drop'
import { useMountedRef } from '@/hooks/useMountedRef'
import { chatWorkspaceByTabId as findTerminalTabWorktreeId } from '../../../../lib/structured-chat-tab-index'
import type { CapturedNativeChatDrop } from './native-chat-pane-file-drop'

export type UseNativeChatExternalAttachmentsArgs = {
  terminalTabId: string
  draftScopeKey?: string
  structuredWorktreeId?: string
  /** The structured chat behind this composer; decides where its uploads are stored. */
  structuredSession?: NativeChatStructuredAttachmentSession
  /** Recheck disabled state after awaits so late uploads cannot attach to a guarded composer. */
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

/** Upload client-local files to the owning agent’s store or SSH .orca/drops before referencing them. */
export function useNativeChatExternalAttachments({
  terminalTabId,
  draftScopeKey,
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

  // Read the current pane through a ref after awaits; closure-based lookup would compare the original workspace to itself.
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
    if (structuredSession?.attachmentStagingScope) {
      return {
        kind: 'local',
        structuredSessionId: structuredSession.sessionId,
        stagingScope: structuredSession.attachmentStagingScope
      }
    }
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
      const destination = draftScopeKey
        ? captureNativeChatEditDraftDestination(draftScopeKey)
        : undefined
      const abandoned = (): boolean => (destination ? !destination.active : disabledRef.current)
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
        (destination ? destination.active : destinationIsCurrent()) &&
        isSameComposerWorkspace(capturedWorkspace, workspaceRef.current) &&
        capturedWorktreeId === currentWorktreeId() &&
        nativeChatAttachmentOwnerUnchanged(owner, resolveAttachmentOwner())
      const refusal = (count: number): string | null => {
        if (destination ? !destination.active : !destinationIsCurrent()) {
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
      const claimedPaths = new Set<string>()
      const run = async (reserved: NativeChatReservedAttachment[]): Promise<void> => {
        if (owner.kind === 'runtime-session') {
          await attachNativeChatSessionAttachmentPaths({
            pending: reserved,
            owner,
            chips,
            options,
            isAbandoned: abandoned,
            ownerStillCurrent,
            setNotice
          })
          return
        }
        await attachNativeChatLocalAttachmentPaths({
          reserved,
          owner,
          chips,
          options,
          claimedPaths,
          isAbandoned: abandoned,
          ownerStillCurrent,
          attachResolvedPaths,
          setNotice
        })
      }
      return {
        chips,
        abandoned,
        admitted: destination !== undefined,
        refusal,
        run,
        claimedPaths,
        preparationConsumer:
          owner.kind === 'local' && owner.structuredSessionId
            ? ('local-chat' as const)
            : ('agent' as const)
      }
    },
    [attachResolvedPaths, draftScopeKey, resolveAttachmentOwner, setNotice]
  )

  const captureExternalDrop = useCallback(
    (
      destinationIsCurrent: () => boolean = () => true,
      options?: NativeChatAttachmentFocusOptions
    ) => {
      const intake = captureIntake(destinationIsCurrent, options)
      const attach = async (paths: string[]): Promise<void> => {
        if (paths.length === 0 || intake.abandoned() || (!intake.admitted && !mountedRef.current)) {
          return
        }
        const notice = intake.refusal(paths.length)
        if (notice) {
          setNotice(notice)
          return
        }
        await intake.run(reserveNativeChatAttachmentChips(intake.chips, paths))
      }
      // Deferred operations own their files until they apply or cancel.
      const deliver: CapturedNativeChatDrop = (paths) =>
        attach(paths).finally(() => {
          releaseBrowserAttachmentFiles(paths.filter((path) => !intake.claimedPaths.has(path)))
        })
      deliver.preparationConsumer = intake.preparationConsumer
      return deliver
    },
    [captureIntake, mountedRef, setNotice]
  )

  // Paste-reserved chips are admitted work and may finish after unmount; refusals must release them.
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
        const notice = intake.abandoned() ? '' : intake.refusal(reserved.length)
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
      } else {
        releaseBrowserAttachmentFiles(paths)
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
