import React, { useCallback } from 'react'
import {
  Copy,
  Download,
  ExternalLink,
  Eye,
  File,
  FilePlus,
  Files,
  FolderPlus,
  Globe,
  ListCollapse,
  Pencil,
  Search,
  SquareTerminal,
  Trash2
} from 'lucide-react'
import { toast } from 'sonner'
import {
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut
} from '@/components/ui/context-menu'
import { useAppStore } from '@/store'
import { useShortcutLabel } from '@/hooks/useShortcutLabel'
import { detectLanguage } from '@/lib/language-detect'
import { openFileInBrowserTab } from '@/lib/file-preview'
import { isLocalPathOpenBlocked, showLocalPathOpenBlockedToast } from '@/lib/local-path-open-guard'
import { translate } from '@/i18n/i18n'
import type { FileExplorerRowProps } from './FileExplorerRow'
import {
  shouldShowCollapseFolderAction,
  shouldShowCopyFileAction,
  shouldShowFindInFolderAction,
  shouldShowOpenInTerminalAction,
  shouldShowRemoteDownloadAction,
  shouldShowViewFileAction
} from './file-explorer-row-action-visibility'
import { copyFileToOsClipboard, downloadRemoteFile } from './file-explorer-row-file-transfer'

const isMac = navigator.userAgent.includes('Mac')
const isLinux = navigator.userAgent.includes('Linux')

/** Platform-appropriate label: macOS → Finder, Windows → File Explorer, Linux → Files */
const revealLabel = isMac
  ? 'Reveal in Finder'
  : isLinux
    ? 'Open Containing Folder'
    : 'Reveal in File Explorer'

function stopRightButtonMenuSelection(event: React.PointerEvent): void {
  if (event.button !== 2) {
    return
  }
  // Why: Radix opens context menus under the pointer; on some macOS/Electron
  // paths the right-button release lands on the first item and selects it.
  event.preventDefault()
  event.stopPropagation()
}

type FileExplorerRowContextMenuProps = Pick<
  FileExplorerRowProps,
  | 'node'
  | 'isExpanded'
  | 'deleteShortcutLabel'
  | 'connectionId'
  | 'runtimeDownloadContext'
  | 'supportsFolderDownload'
  | 'canOpenInOrcaBrowser'
  | 'canCollapseFolderSubtree'
  | 'targetDir'
  | 'targetDepth'
  | 'selectionSize'
  | 'onViewFile'
  | 'onCopyPaths'
  | 'onStartNew'
  | 'onStartRename'
  | 'onDuplicate'
  | 'onAddFolderAsProject'
  | 'canAddAsProject'
  | 'onOpenInTerminal'
  | 'onRequestDelete'
  | 'onCollapseFolderSubtree'
  | 'onFindInFolder'
>

export function FileExplorerRowContextMenu({
  node,
  isExpanded,
  deleteShortcutLabel,
  connectionId,
  runtimeDownloadContext,
  supportsFolderDownload,
  canOpenInOrcaBrowser,
  canCollapseFolderSubtree,
  targetDir,
  targetDepth,
  selectionSize,
  onViewFile,
  onCopyPaths,
  onStartNew,
  onStartRename,
  onDuplicate,
  onAddFolderAsProject,
  canAddAsProject,
  onOpenInTerminal,
  onRequestDelete,
  onCollapseFolderSubtree,
  onFindInFolder
}: FileExplorerRowContextMenuProps): React.JSX.Element {
  const openMarkdownPreview = useAppStore((s) => s.openMarkdownPreview)
  const activeWorktreeId = useAppStore((s) => s.activeWorktreeId)
  const copyPathShortcutLabel = useShortcutLabel('fileExplorer.copyPath')
  const copyRelativePathShortcutLabel = useShortcutLabel('fileExplorer.copyRelativePath')
  const findInFolderShortcutLabel = useShortcutLabel('sidebar.search.toggle')
  const showRemoteDownloadAction = shouldShowRemoteDownloadAction(
    node,
    connectionId,
    runtimeDownloadContext,
    supportsFolderDownload
  )
  const showCopyFileAction = shouldShowCopyFileAction(node, connectionId, selectionSize)
  const handleOpenInOrcaBrowser = useCallback(() => {
    if (!activeWorktreeId) {
      return
    }
    const result = openFileInBrowserTab({ filePath: node.path, worktreeId: activeWorktreeId })
    if (result.status === 'unsupported') {
      toast.error(result.message)
    }
  }, [activeWorktreeId, node.path])
  const handleDownload = useCallback(() => {
    const downloadTarget = connectionId || runtimeDownloadContext
    if (!downloadTarget) {
      return
    }
    void downloadRemoteFile(node, downloadTarget)
  }, [connectionId, node, runtimeDownloadContext])
  const handleCopyFile = useCallback(() => {
    void copyFileToOsClipboard(node, connectionId)
  }, [connectionId, node])

  return (
    <ContextMenuContent
      className="w-64 bg-[rgba(255,255,255,0.82)] dark:bg-[rgba(0,0,0,0.72)]"
      onPointerUpCapture={stopRightButtonMenuSelection}
      onCloseAutoFocus={(e) => e.preventDefault()}
    >
      <ContextMenuItem onSelect={() => onStartNew('file', targetDir, targetDepth)}>
        <FilePlus />
        {translate('auto.components.right.sidebar.FileExplorerRow.37c875d827', 'New File')}
      </ContextMenuItem>
      <ContextMenuItem onSelect={() => onStartNew('folder', targetDir, targetDepth)}>
        <FolderPlus />
        {translate('auto.components.right.sidebar.FileExplorerRow.f61af83316', 'New Folder')}
      </ContextMenuItem>
      <ContextMenuSeparator />
      {showCopyFileAction && (
        <ContextMenuItem onSelect={handleCopyFile}>
          <Copy />
          {translate('auto.components.right.sidebar.FileExplorerRow.98a79948b3', 'Copy')}
        </ContextMenuItem>
      )}
      <ContextMenuItem onSelect={() => onCopyPaths('absolute')}>
        <Copy />
        {selectionSize > 1
          ? translate('auto.components.right.sidebar.FileExplorerRow.f9d7ca753d', 'Copy Paths')
          : translate('auto.components.right.sidebar.FileExplorerRow.b5d436aa30', 'Copy Path')}
        {copyPathShortcutLabel !== 'Unassigned' ? (
          <ContextMenuShortcut>{copyPathShortcutLabel}</ContextMenuShortcut>
        ) : null}
      </ContextMenuItem>
      <ContextMenuItem onSelect={() => onCopyPaths('relative')}>
        <Copy />
        {selectionSize > 1
          ? translate(
              'auto.components.right.sidebar.FileExplorerRow.42e10cbf57',
              'Copy Relative Paths'
            )
          : translate(
              'auto.components.right.sidebar.FileExplorerRow.66a29dde82',
              'Copy Relative Path'
            )}
        {copyRelativePathShortcutLabel !== 'Unassigned' ? (
          <ContextMenuShortcut>{copyRelativePathShortcutLabel}</ContextMenuShortcut>
        ) : null}
      </ContextMenuItem>
      {!node.isDirectory && (
        <ContextMenuItem onSelect={() => onDuplicate(node)}>
          <Files />
          {translate('auto.components.right.sidebar.FileExplorerRow.0fec99bfd7', 'Duplicate')}
        </ContextMenuItem>
      )}
      {canAddAsProject && (
        <ContextMenuItem onSelect={onAddFolderAsProject}>
          <FolderPlus />
          {translate(
            'auto.components.right.sidebar.FileExplorerRow.1bb9be455c',
            'Add as Project...'
          )}
        </ContextMenuItem>
      )}
      {shouldShowOpenInTerminalAction(node) && (
        <ContextMenuItem onSelect={onOpenInTerminal}>
          <SquareTerminal />
          {translate(
            'auto.components.right.sidebar.FileExplorerRow.e887fa4b2e',
            'Open in Terminal'
          )}
        </ContextMenuItem>
      )}
      {shouldShowViewFileAction(node) && (
        <ContextMenuItem onSelect={onViewFile}>
          <File />
          {translate('auto.components.right.sidebar.FileExplorerRow.1d8e182c32', 'View File')}
        </ContextMenuItem>
      )}
      {!node.isDirectory && activeWorktreeId && canOpenInOrcaBrowser && (
        <ContextMenuItem onSelect={handleOpenInOrcaBrowser}>
          <Globe />
          {translate(
            'auto.components.right.sidebar.FileExplorerRow.dd112c81d2',
            'Open in Orca Browser'
          )}
        </ContextMenuItem>
      )}
      {!node.isDirectory && activeWorktreeId && detectLanguage(node.path) === 'markdown' && (
        <ContextMenuItem
          onSelect={() =>
            openMarkdownPreview({
              filePath: node.path,
              relativePath: node.relativePath,
              worktreeId: activeWorktreeId,
              language: 'markdown'
            })
          }
        >
          <Eye />
          {translate(
            'auto.components.right.sidebar.FileExplorerRow.d87a4c42e1',
            'Open Markdown Preview'
          )}
        </ContextMenuItem>
      )}
      {showRemoteDownloadAction && (
        <ContextMenuItem onSelect={handleDownload}>
          <Download />
          {node.isDirectory
            ? translate(
                'auto.components.right.sidebar.FileExplorerRow.7ac885bd2f',
                'Download Folder'
              )
            : translate('auto.components.right.sidebar.FileExplorerRow.c2112579f6', 'Download')}
        </ContextMenuItem>
      )}
      {canCollapseFolderSubtree && shouldShowCollapseFolderAction(node, isExpanded) && (
        <ContextMenuItem onSelect={onCollapseFolderSubtree}>
          <ListCollapse />
          {translate('auto.components.right.sidebar.FileExplorerRow.d6a25618aa', 'Collapse Folder')}
        </ContextMenuItem>
      )}
      {shouldShowFindInFolderAction(node) && (
        <ContextMenuItem onSelect={onFindInFolder}>
          <Search />
          {translate('auto.components.right.sidebar.FileExplorerRow.0df0e5abac', 'Find in Folder')}
          {findInFolderShortcutLabel !== 'Unassigned' ? (
            <ContextMenuShortcut>{findInFolderShortcutLabel}</ContextMenuShortcut>
          ) : null}
        </ContextMenuItem>
      )}
      <ContextMenuItem
        onSelect={() => {
          const state = useAppStore.getState()
          const activeWorktree = Object.values(state.worktreesByRepo)
            .flat()
            .find((worktree) => worktree.id === activeWorktreeId)
          const activeRepo = activeWorktree
            ? state.repos.find((repo) => repo.id === activeWorktree.repoId)
            : null
          if (
            isLocalPathOpenBlocked(state.settings, {
              connectionId: activeRepo?.connectionId ?? null
            })
          ) {
            showLocalPathOpenBlockedToast()
            return
          }
          window.api.shell.openPath(node.path)
        }}
      >
        <ExternalLink />
        {revealLabel}
      </ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem onSelect={() => onStartRename(node)}>
        <Pencil />
        {translate('auto.components.right.sidebar.FileExplorerRow.fc747429bf', 'Rename')}
        <ContextMenuShortcut>
          {isMac
            ? '↩'
            : translate('auto.components.right.sidebar.FileExplorerRow.a06551beee', 'Enter')}
        </ContextMenuShortcut>
      </ContextMenuItem>
      <ContextMenuItem variant="destructive" onSelect={onRequestDelete}>
        <Trash2 />
        {translate('auto.components.right.sidebar.FileExplorerRow.addc01145f', 'Delete')}
        <ContextMenuShortcut>{deleteShortcutLabel}</ContextMenuShortcut>
      </ContextMenuItem>
    </ContextMenuContent>
  )
}
