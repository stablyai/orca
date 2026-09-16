import { useCallback, useLayoutEffect, useRef, type DragEventHandler } from 'react'
import { useAppStore } from '@/store'
import { getExecutionHostIdForWorktree } from '@/lib/worktree-runtime-owner'
import {
  getWorkspaceFileDragRejectionMessage,
  hasWorkspaceFileDragType,
  isResolvedWorkspaceFileDragExecutionHost,
  readWorkspaceFileDragPaths,
  readWorkspaceFileDragSource
} from '@/lib/workspace-file-drag'
import {
  resolveNativeChatAttachmentOwnerForWorktree,
  nativeChatWorktreeNotReadyNotice
} from './native-chat-attachment-upload'
import { findTerminalTabWorktreeId } from './native-chat-file-link'
import {
  nativeChatAttachmentOwnerUnchanged,
  nativeChatWorkspaceAttachmentMismatchNotice,
  type NativeChatResolvedPathOptions
} from './native-chat-resolved-path-ownership'
import { useNativeChatPaneFileDropClaim } from './NativeChatPaneFileDropSurface'

type WorkspaceFileDropHandlers = {
  onDragOverCapture: DragEventHandler<HTMLDivElement>
  onDropCapture: DragEventHandler<HTMLDivElement>
}

type Args = {
  attachResolvedPaths: (
    paths: string[],
    connectionId?: string | null,
    options?: NativeChatResolvedPathOptions
  ) => void
  disabled: boolean
  /** Composer identity the preload drop route addresses; published to the pane
   *  so an OS drop anywhere in it resolves to this composer. */
  paneKey: string
  setNotice: (notice: string | null) => void
  structuredWorktreeId?: string
  terminalTabId: string
}

// The composer sits inside the terminal surface, which accepts the same drag and
// pastes it into the shell. Claiming the event here is what keeps a drop aimed at
// the composer out of the terminal behind it — including when we refuse it.
function claimWorkspaceFileDrag(event: React.DragEvent<HTMLDivElement>): void {
  event.preventDefault()
  event.stopPropagation()
}

function setDropEffect(dataTransfer: DataTransfer, effect: 'copy' | 'none'): void {
  if (effect === 'none') {
    dataTransfer.dropEffect = 'none'
    return
  }
  if (
    dataTransfer.effectAllowed === 'all' ||
    dataTransfer.effectAllowed === 'copy' ||
    dataTransfer.effectAllowed === 'copyLink' ||
    dataTransfer.effectAllowed === 'copyMove' ||
    dataTransfer.effectAllowed === 'uninitialized'
  ) {
    dataTransfer.dropEffect = 'copy'
  }
}

export function useNativeChatWorkspaceFileDrop({
  attachResolvedPaths,
  disabled,
  paneKey,
  setNotice,
  structuredWorktreeId,
  terminalTabId
}: Args): WorkspaceFileDropHandlers {
  // The IME-flush check runs against a closure captured at drop time. Reading
  // the prop through a ref keeps "is this still my workspace?" a real question
  // rather than a comparison of one captured value against itself.
  const structuredWorktreeIdRef = useRef(structuredWorktreeId)
  useLayoutEffect(() => {
    structuredWorktreeIdRef.current = structuredWorktreeId
  }, [structuredWorktreeId])

  const onDragOverCapture = useCallback<DragEventHandler<HTMLDivElement>>(
    (event) => {
      if (!hasWorkspaceFileDragType(event.dataTransfer)) {
        return
      }
      claimWorkspaceFileDrag(event)
      // A guarded composer answers `none` rather than promising a copy it will
      // then drop on the floor: the cursor refuses, and no drop event follows.
      setDropEffect(event.dataTransfer, disabled ? 'none' : 'copy')
    },
    [disabled]
  )

  const onDropCapture = useCallback<DragEventHandler<HTMLDivElement>>(
    (event) => {
      if (!hasWorkspaceFileDragType(event.dataTransfer)) {
        return
      }
      claimWorkspaceFileDrag(event)
      if (disabled) {
        setDropEffect(event.dataTransfer, 'none')
        return
      }
      setDropEffect(event.dataTransfer, 'copy')

      const dragPaths = readWorkspaceFileDragPaths(event.dataTransfer)
      if (dragPaths.status === 'rejected') {
        setNotice(getWorkspaceFileDragRejectionMessage(dragPaths.reason))
        return
      }
      if (dragPaths.paths.length === 0) {
        return
      }

      const state = useAppStore.getState()
      const workspaceId =
        structuredWorktreeId ?? findTerminalTabWorktreeId(state.tabsByWorktree, terminalTabId)
      const source = readWorkspaceFileDragSource(event.dataTransfer)
      if (!workspaceId || !source || source.workspaceId !== workspaceId) {
        setNotice(nativeChatWorkspaceAttachmentMismatchNotice())
        return
      }
      const owner = resolveNativeChatAttachmentOwnerForWorktree(
        state,
        workspaceId,
        structuredWorktreeId ? undefined : terminalTabId
      )
      if (owner.kind === 'not-ready') {
        setNotice(nativeChatWorktreeNotReadyNotice())
        return
      }
      const targetExecutionHostId = getExecutionHostIdForWorktree(state, workspaceId)
      if (
        !isResolvedWorkspaceFileDragExecutionHost(targetExecutionHostId) ||
        source.executionHostId !== targetExecutionHostId
      ) {
        setNotice(nativeChatWorkspaceAttachmentMismatchNotice())
        return
      }

      const targetOwnerIsCurrent = (): boolean => {
        const currentState = useAppStore.getState()
        const currentWorkspaceId =
          structuredWorktreeIdRef.current ??
          findTerminalTabWorktreeId(currentState.tabsByWorktree, terminalTabId)
        if (currentWorkspaceId !== source.workspaceId) {
          return false
        }
        const currentHostId = getExecutionHostIdForWorktree(currentState, currentWorkspaceId)
        const currentOwner = resolveNativeChatAttachmentOwnerForWorktree(
          currentState,
          currentWorkspaceId,
          structuredWorktreeIdRef.current ? undefined : terminalTabId
        )
        return (
          isResolvedWorkspaceFileDragExecutionHost(currentHostId) &&
          currentHostId === source.executionHostId &&
          nativeChatAttachmentOwnerUnchanged(owner, currentOwner)
        )
      }

      attachResolvedPaths(dragPaths.paths, owner.kind === 'ssh' ? owner.connectionId : undefined, {
        targetOwnerIsCurrent
      })
    },
    [attachResolvedPaths, disabled, setNotice, structuredWorktreeId, terminalTabId]
  )

  // The pane around the composer is the drop surface; these handlers run from
  // there so the whole chat, not just the input box, accepts a file.
  useNativeChatPaneFileDropClaim({
    scopeKey: paneKey,
    disabled,
    onDragOverCapture,
    onDropCapture
  })

  return { onDragOverCapture, onDropCapture }
}
