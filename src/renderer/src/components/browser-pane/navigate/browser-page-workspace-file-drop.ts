import type { DragEvent, RefObject } from 'react'
import { toast } from 'sonner'
import { convertBrowserPageToWorkspaceDoc } from '@/lib/browser/documents/file-preview-page-conversion'
import { translate } from '@/i18n/i18n'
import { resolveWorkspaceDocAddressTarget } from '@/lib/browser/documents/workspace-doc-address-input'
import {
  getWorkspaceFileBrowserOpenTarget,
  remoteFileBrowserUnsupportedMessage
} from '@/lib/browser/documents/workspace-file-browser-open-target'
import {
  getWorkspaceFileDragRejectionMessage,
  readWorkspaceFileDragPaths,
  readWorkspaceFileDragSource,
  WORKSPACE_FILE_PATH_MIME
} from '@/lib/files/drop/workspace-file-drag'
import { useAppStore } from '@/store'
import type { BrowserPageDocLocation } from '../../../../../shared/browser/workspaces/browser-workspace-types'

/** What a workspace file dropped on a browser page should do; the pane carries it out. */
export type BrowserPageWorkspaceFileDrop =
  | { kind: 'navigate'; url: string }
  | { kind: 'workspace-doc'; docLocation: BrowserPageDocLocation }
  | { kind: 'notice'; message: string }

export function acceptBrowserPageWorkspaceFileDragOver(event: DragEvent<HTMLElement>): void {
  if (!event.dataTransfer.types.includes(WORKSPACE_FILE_PATH_MIME)) {
    return
  }
  event.preventDefault()
  event.stopPropagation()
  event.dataTransfer.dropEffect = 'copy'
}

/** Null when the drop is not a workspace file. Local files open as file:// only where the page allows it; remote files open through the workspace document view, as the address bar does. */
export function resolveBrowserPageWorkspaceFileDrop(
  event: DragEvent<HTMLElement>,
  options: { worktreeId: string; pageRect: DOMRect | null; allowFileUrl: boolean }
): BrowserPageWorkspaceFileDrop | null {
  if (!event.dataTransfer.types.includes(WORKSPACE_FILE_PATH_MIME)) {
    return null
  }
  event.preventDefault()
  event.stopPropagation()

  // Why: a browser opens one URL, so reject multi-path drags rather than silently opening the lead file.
  const dragPaths = readWorkspaceFileDragPaths(event.dataTransfer, { maxPaths: 1 })
  if (dragPaths.status === 'rejected') {
    return { kind: 'notice', message: getWorkspaceFileDragRejectionMessage(dragPaths.reason) }
  }
  const filePath = dragPaths.paths[0]
  if (!filePath) {
    return null
  }

  const target = resolveDropTarget(event, filePath, options)
  if (!target || target.kind === 'notice') {
    return target
  }
  const rect = options.pageRect
  if (!rect) {
    return {
      kind: 'notice',
      message: translate(
        'auto.components.browser.pane.navigate.use.browser.page.navigation.downloads.8683b84b9e',
        'Browser page is not ready for file drops.'
      )
    }
  }
  const pageX = event.clientX - rect.left
  const pageY = event.clientY - rect.top
  if (pageX < 0 || pageY < 0 || pageX > rect.width || pageY > rect.height) {
    return {
      kind: 'notice',
      message: translate(
        'auto.components.browser.pane.navigate.use.browser.page.navigation.downloads.22272f2784',
        'Drop files over the browser page, not the toolbar.'
      )
    }
  }
  return target
}

function resolveDropTarget(
  event: DragEvent<HTMLElement>,
  filePath: string,
  options: { worktreeId: string; allowFileUrl: boolean }
): BrowserPageWorkspaceFileDrop | null {
  const source = readWorkspaceFileDragSource(event.dataTransfer)
  if (!source) {
    return { kind: 'notice', message: remoteFileBrowserUnsupportedMessage() }
  }
  // A file URL reads this machine, regardless of which workspace owns the browser.
  if (source.executionHostId === 'local') {
    if (!options.allowFileUrl) {
      return null
    }
    const target = getWorkspaceFileBrowserOpenTarget({ filePath, worktreeId: options.worktreeId })
    return target.status === 'unsupported'
      ? { kind: 'notice', message: target.message }
      : { kind: 'navigate', url: target.url }
  }
  const docTarget = resolveWorkspaceDocAddressTarget(
    useAppStore.getState(),
    source.workspaceId,
    filePath
  )
  if (docTarget.status === 'workspace-doc') {
    return { kind: 'workspace-doc', docLocation: docTarget.docLocation }
  }
  return {
    kind: 'notice',
    message:
      docTarget.status === 'unsupported' ? docTarget.message : remoteFileBrowserUnsupportedMessage()
  }
}

/** Client guests refuse file:// documents, so only remote workspace files open there. */
export function useClientPageWorkspaceFileDrop(
  browserPageId: string,
  worktreeId: string,
  viewportRef: RefObject<HTMLDivElement | null>
): {
  onDragOver: (event: DragEvent<HTMLDivElement>) => void
  onDrop: (event: DragEvent<HTMLDivElement>) => void
} {
  return {
    onDragOver: acceptBrowserPageWorkspaceFileDragOver,
    onDrop: (event) => {
      const drop = resolveBrowserPageWorkspaceFileDrop(event, {
        worktreeId,
        pageRect: viewportRef.current?.getBoundingClientRect() ?? null,
        allowFileUrl: false
      })
      if (drop?.kind === 'notice') {
        toast.error(drop.message)
      } else if (drop?.kind === 'workspace-doc') {
        convertBrowserPageToWorkspaceDoc(browserPageId, drop.docLocation)
      }
    }
  }
}
