import { useCallback, useLayoutEffect, useRef, type DragEventHandler } from 'react'
import { useAppStore } from '@/store'
import {
  getWorkspaceFileDragRejectionMessage,
  hasWorkspaceFileDragType,
  isResolvedWorkspaceFileDragExecutionHost,
  readWorkspaceFileDragPaths,
  readWorkspaceFileDragSource
} from '@/lib/workspace-file-drag'
import {
  resolveNativeChatAttachmentOwnerForWorktree,
  resolveNativeChatAttachmentHost,
  nativeChatWorktreeNotReadyNotice
} from './native-chat-attachment-upload'
import { findTerminalTabWorktreeId } from './native-chat-file-link'
import { parseExecutionHostId } from '../../../../shared/execution-host'
import {
  nativeChatAttachmentOwnerUnchanged,
  nativeChatWorkspaceAttachmentMismatchNotice,
  type NativeChatResolvedPathOptions
} from './native-chat-resolved-path-ownership'

export type NativeChatResolvedPathSink = (
  paths: string[],
  connectionId?: string | null,
  options?: NativeChatResolvedPathOptions
) => void

type WorkspaceFileDropHandlers = {
  onDragOverCapture: DragEventHandler<HTMLDivElement>
  /** `attachTo`: a destination inside the pane that takes this drop instead of the composer. */
  onDropCapture: (
    event: React.DragEvent<HTMLDivElement>,
    attachTo?: NativeChatResolvedPathSink
  ) => void
}

type Args = {
  attachResolvedPaths: NativeChatResolvedPathSink
  disabled: boolean
  setNotice: (notice: string | null) => void
  structuredWorktreeId?: string
  terminalTabId: string
}

// Claim even refused composer drops so the terminal surface behind it cannot paste them into the shell.
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
  setNotice,
  structuredWorktreeId,
  terminalTabId
}: Args): WorkspaceFileDropHandlers {
  // IME flushing retains the drop-time closure; read live workspace ownership through a ref to detect later switches.
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
      // Refuse guarded composers via the cursor; promising copy would silently discard the drop.
      setDropEffect(event.dataTransfer, disabled ? 'none' : 'copy')
    },
    [disabled]
  )

  const onDropCapture = useCallback<WorkspaceFileDropHandlers['onDropCapture']>(
    (event, attachTo) => {
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
      const owner = resolveNativeChatAttachmentOwnerForWorktree(state, workspaceId)
      if (owner.kind === 'not-ready') {
        setNotice(nativeChatWorktreeNotReadyNotice())
        return
      }
      const targetExecutionHostId = resolveNativeChatAttachmentHost(state, workspaceId)
      if (
        !targetExecutionHostId ||
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
        const currentHostId = resolveNativeChatAttachmentHost(currentState, currentWorkspaceId)
        const currentOwner = resolveNativeChatAttachmentOwnerForWorktree(
          currentState,
          currentWorkspaceId
        )
        return (
          currentHostId !== null &&
          isResolvedWorkspaceFileDragExecutionHost(currentHostId) &&
          currentHostId === source.executionHostId &&
          nativeChatAttachmentOwnerUnchanged(owner, currentOwner)
        )
      }

      const targetHost = parseExecutionHostId(targetExecutionHostId)
      const attach = attachTo ?? attachResolvedPaths
      attach(dragPaths.paths, targetHost?.kind === 'ssh' ? targetHost.targetId : undefined, {
        targetOwnerIsCurrent
      })
    },
    [attachResolvedPaths, disabled, setNotice, structuredWorktreeId, terminalTabId]
  )

  return { onDragOverCapture, onDropCapture }
}
