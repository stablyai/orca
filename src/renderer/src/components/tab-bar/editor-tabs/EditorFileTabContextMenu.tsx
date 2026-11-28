import { Copy, CopyX, ExternalLink, Eye, ListX, Pencil, Pin, PinOff, X } from 'lucide-react'
import {
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuContent
} from '@/components/ui/context-menu'
import { useAppStore } from '@/store/index'
import { useOptionalShortcutLabel } from '@/lib/keyboard/useShortcutLabel'
import type { OpenFile } from '../../../store/slices/editor/types/open-file'
import { useTranslate } from '@/i18n/use-translate'
import { LocalOnlyMenuHint } from '@/components/ui/local-only-menu-hint'
import {
  getRevealInFileManagerLabel,
  getWorkspaceFileRevealOwner,
  revealInFileManager
} from '@/lib/files/os-open/reveal-in-file-manager'
import { isRevealOrEditorOpenBlocked } from '@/lib/files/os-open/local-path-open-guard'
import { formatClipboardFilePath } from '@/lib/clipboard/clipboard-file-path'
import { absolutePathBasename } from '@/lib/path'
import { TabWorkspaceLayoutMenuSection } from '../pane-actions/TabWorkspaceLayoutMenuSection'
import { CopyTabIdMenuItem } from '../pane-actions/CopyTabIdMenuItem'
import {
  isVirtualEditorFile,
  isWorktreeRootEditorFile
} from '@/store/slices/editor/tabs/editor-tab-content-type'
import { CloseSplitPaneMenuItem } from '../pane-actions/CloseSplitPaneMenuItem'

type EditorFileTabContextMenuProps = {
  file: OpenFile & { tabId?: string }
  unifiedTabId: string
  groupId: string
  isPinned: boolean
  isRenaming: boolean
  hasTabsToRight: boolean
  hasTabsToLeft: boolean
  tabCount: number
  canRename: boolean
  canShowMarkdownPreview: boolean
  resolvedLanguage: string
  repoConnectionId: string | null
  skipMenuFocusRestoreRef: React.MutableRefObject<boolean>
  onActivate: () => void
  onOpenRenameInput: () => void
  onTogglePin: () => void
  onClose: () => void
  onCloseOthers: () => void
  onCloseAll: () => void
  onCloseToRight: () => void
  onCloseToLeft: () => void
  onCloseSplitPane?: () => void
  onOpenMarkdownPreview: (
    file: {
      filePath: string
      relativePath: string
      worktreeId: string
      runtimeEnvironmentId?: string | null
      language: string
    },
    options: { sourceFileId: string }
  ) => void
}

export function EditorFileTabContextMenu({
  file,
  unifiedTabId,
  groupId,
  isPinned,
  isRenaming,
  tabCount,
  canRename,
  canShowMarkdownPreview,
  resolvedLanguage,
  repoConnectionId,
  skipMenuFocusRestoreRef,
  onActivate,
  onOpenRenameInput,
  onTogglePin,
  onClose,
  onCloseOthers,
  onCloseAll,
  onCloseSplitPane,
  onOpenMarkdownPreview
}: EditorFileTabContextMenuProps): React.JSX.Element {
  const t = useTranslate()
  const renameShortcut = useOptionalShortcutLabel('tab.rename')
  const closeShortcut = useOptionalShortcutLabel('tab.close')
  const closeAllShortcut = useOptionalShortcutLabel('tab.closeAll')
  const revealOwner = useAppStore((s) =>
    getWorkspaceFileRevealOwner(s, file.worktreeId, {
      connectionId: file.externalSshTargetId ?? repoConnectionId,
      runtimeEnvironmentId: file.runtimeEnvironmentId
    })
  )
  const revealBlocked = isRevealOrEditorOpenBlocked(revealOwner)

  return (
    <ContextMenuContent
      animation="none"
      className="min-w-[13rem] max-w-[calc(100vw-1rem)] whitespace-nowrap"
      onCloseAutoFocus={(event) => {
        if (!skipMenuFocusRestoreRef.current) {
          return
        }
        skipMenuFocusRestoreRef.current = false
        event.preventDefault()
        // Open rename after menu autofocus closes; onSelect would let menu focus restoration blur-commit it immediately.
        onActivate()
        onOpenRenameInput()
      }}
    >
      <TabWorkspaceLayoutMenuSection
        unifiedTabId={unifiedTabId}
        groupId={groupId}
        trailingSeparator
      />
      <ContextMenuItem
        disabled={!canRename || isRenaming}
        onSelect={() => {
          skipMenuFocusRestoreRef.current = true
        }}
      >
        <Pencil className="size-3.5" />
        {t('auto.components.tab.bar.EditorFileTabContextMenu.68cc610e7f', 'Rename')}
        {renameShortcut ? <ContextMenuShortcut>{renameShortcut}</ContextMenuShortcut> : null}
      </ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem onSelect={onTogglePin}>
        {isPinned ? <PinOff className="size-3.5" /> : <Pin className="size-3.5" />}
        {isPinned
          ? t('auto.components.tab.bar.EditorFileTabContextMenu.8e9d603a09', 'Unpin Tab')
          : t('auto.components.tab.bar.EditorFileTabContextMenu.fdd29eb669', 'Pin Tab')}
      </ContextMenuItem>
      <CopyTabIdMenuItem menuKind="context" unifiedTabId={unifiedTabId} />
      <ContextMenuSeparator />
      <ContextMenuItem onSelect={() => !isPinned && onClose()} disabled={isPinned}>
        <X className="size-3.5" />
        {t('auto.components.tab.bar.EditorFileTabContextMenu.1ba8492c5b', 'Close')}
        {closeShortcut ? <ContextMenuShortcut>{closeShortcut}</ContextMenuShortcut> : null}
      </ContextMenuItem>
      <ContextMenuItem onSelect={onCloseOthers} disabled={tabCount <= 1}>
        <CopyX className="size-3.5" />
        {t('components.tab.bar.EditorFileTabContextMenu.closeOthers', 'Close Others')}
      </ContextMenuItem>
      <ContextMenuItem onSelect={onCloseAll}>
        <ListX className="size-3.5" />
        {t('auto.components.tab.bar.EditorFileTabContextMenu.ba1369dd24', 'Close All Editor Tabs')}
        {closeAllShortcut ? <ContextMenuShortcut>{closeAllShortcut}</ContextMenuShortcut> : null}
      </ContextMenuItem>
      <CloseSplitPaneMenuItem menuKind="context" onCloseSplitPane={onCloseSplitPane} />
      {isVirtualEditorFile(file) ? null : <ContextMenuSeparator />}
      {canShowMarkdownPreview ? (
        <>
          <ContextMenuItem
            onSelect={() => {
              onActivate()
              onOpenMarkdownPreview(
                {
                  filePath: file.filePath,
                  relativePath: file.relativePath,
                  worktreeId: file.worktreeId,
                  runtimeEnvironmentId: file.runtimeEnvironmentId,
                  language: resolvedLanguage
                },
                { sourceFileId: file.id }
              )
            }}
          >
            <Eye className="size-3.5" />
            {t(
              'auto.components.tab.bar.EditorFileTabContextMenu.bfd5797ef4',
              'Open Markdown Preview'
            )}
          </ContextMenuItem>
          <ContextMenuSeparator />
        </>
      ) : null}
      {/* Why: virtual editor tabs use synthetic ids instead of on-disk paths. */}
      {!isVirtualEditorFile(file) && (
        <>
          <ContextMenuItem
            onSelect={() => {
              void window.api.ui.writeClipboardText(
                formatClipboardFilePath(file.filePath, revealOwner)
              )
            }}
          >
            <Copy className="size-3.5" />
            {t('auto.components.tab.bar.EditorFileTabContextMenu.5b85754786', 'Copy Path')}
          </ContextMenuItem>
          <ContextMenuItem
            onSelect={() => {
              void window.api.ui.writeClipboardText(file.relativePath)
            }}
          >
            <Copy className="size-3.5" />
            {t('auto.components.tab.bar.EditorFileTabContextMenu.52ce4f4605', 'Copy Relative Path')}
          </ContextMenuItem>
          {!isWorktreeRootEditorFile(file) && (
            <ContextMenuItem
              inset
              onSelect={() => {
                void window.api.ui.writeClipboardText(absolutePathBasename(file.filePath))
              }}
            >
              {t('auto.components.tab.bar.EditorFileTabContextMenu.copyFileName', 'Copy File Name')}
            </ContextMenuItem>
          )}
          <ContextMenuSeparator />
          <ContextMenuItem
            disabled={revealBlocked}
            onSelect={() => void revealInFileManager(file.filePath, revealOwner)}
          >
            <ExternalLink className="size-3.5" />
            {getRevealInFileManagerLabel(t)}
            {revealBlocked ? <LocalOnlyMenuHint /> : null}
          </ContextMenuItem>
        </>
      )}
    </ContextMenuContent>
  )
}
