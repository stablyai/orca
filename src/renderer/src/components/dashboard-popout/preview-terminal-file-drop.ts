import type { Terminal } from '@xterm/xterm'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { getExecutionHostIdForWorktree } from '@/lib/worktree-runtime-owner'
import { parsePaneKey } from '../../../../shared/stable-pane-id'
import {
  hasWorkspaceFileDragType,
  readWorkspaceFileDragSource,
  readWorkspaceFileDragPaths,
  getWorkspaceFileDragRejectionMessage,
  isResolvedWorkspaceFileDragExecutionHost
} from '@/lib/workspace-file-drag'
import {
  handleInternalTerminalFileDrop,
  handleTerminalFileDrop
} from '../terminal-pane/terminal-drop-handler'
import type {
  TerminalDropSurface,
  TerminalDropTransport
} from '../terminal-pane/terminal-drop-surface'
import type { PreviewTerminalWorkspace } from './agent-terminal-preview-props'

export function installPreviewTerminalFileDrop(args: {
  container: HTMLElement
  terminal: Terminal
  ptyId: string
  workspace: PreviewTerminalWorkspace
  isCurrent: () => boolean
}): () => void {
  const { container, workspace } = args
  let disposed = false
  const isCurrent = (): boolean =>
    !disposed &&
    container.isConnected &&
    args.isCurrent() &&
    getExecutionHostIdForWorktree(useAppStore.getState(), workspace.worktreeId) ===
      workspace.executionHostId
  const leafId = workspace.paneKey ? parsePaneKey(workspace.paneKey)?.leafId : undefined
  const pane = { id: 0, leafId: leafId ?? args.ptyId, container, terminal: args.terminal }
  const manager: TerminalDropSurface = {
    getPanes: () => (isCurrent() ? [pane] : []),
    getActivePane: () => (isCurrent() ? pane : null)
  }
  const transport: TerminalDropTransport = {
    getPtyId: () => args.ptyId,
    isConnected: isCurrent,
    sendInput: () => false,
    sendInputAccepted: (data) => window.api.terminalPreview.input(args.ptyId, data)
  }
  const paneTransports = new Map([[pane.id, transport]])
  const dropArgs = {
    manager,
    paneTransports,
    worktreeId: workspace.worktreeId,
    tabId: workspace.tabId,
    cwd: workspace.cwd
  }
  // A fresh registration fences preload events still in flight from a previous connection.
  const scope = crypto.randomUUID()
  container.dataset.nativeFileDropTarget = 'terminal'
  container.dataset.terminalTabId = workspace.tabId
  container.dataset.terminalPreviewSurfaceId = scope
  const offNative = window.api.ui.onFileDrop((data) => {
    if (data.target !== 'terminal' || data.previewSurfaceId !== scope || !isCurrent()) {
      return
    }
    void handleTerminalFileDrop({ ...dropArgs, data })
  })
  const onDragOver = (event: DragEvent): void => {
    if (!event.dataTransfer || !hasWorkspaceFileDragType(event.dataTransfer)) {
      return
    }
    event.preventDefault()
    event.stopPropagation()
    event.dataTransfer.dropEffect = isCurrent() ? 'copy' : 'none'
  }
  const onDrop = (event: DragEvent): void => {
    const dataTransfer = event.dataTransfer
    if (!dataTransfer || !hasWorkspaceFileDragType(dataTransfer)) {
      return
    }
    event.preventDefault()
    event.stopPropagation()
    if (!isCurrent()) {
      return
    }
    const source = readWorkspaceFileDragSource(dataTransfer)
    if (!source || !isResolvedWorkspaceFileDragExecutionHost(source.executionHostId)) {
      return
    }
    if (source.executionHostId === workspace.executionHostId) {
      void handleInternalTerminalFileDrop({ ...dropArgs, dataTransfer, dropTarget: container })
      return
    }
    if (source.executionHostId === 'local') {
      const paths = readWorkspaceFileDragPaths(dataTransfer)
      if (paths.status === 'rejected') {
        toast.error(getWorkspaceFileDragRejectionMessage(paths.reason))
        return
      }
      void handleTerminalFileDrop({ ...dropArgs, data: { target: 'terminal', paths: paths.paths } })
      return
    }
    toast.error(
      translate(
        'sessionGrid.drop.differentHost',
        'Files from another remote host cannot be dropped here.'
      )
    )
  }
  container.addEventListener('dragover', onDragOver)
  container.addEventListener('drop', onDrop)
  return () => {
    disposed = true
    offNative()
    container.removeEventListener('dragover', onDragOver)
    container.removeEventListener('drop', onDrop)
    if (container.dataset.terminalPreviewSurfaceId === scope) {
      container.dataset.nativeFileDropTarget = 'rejected'
      delete container.dataset.terminalTabId
      delete container.dataset.terminalPreviewSurfaceId
    }
  }
}
