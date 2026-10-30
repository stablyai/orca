import { Pencil, Pin, PinOff, X } from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { useAppStore } from '@/store'
import { useOptionalShortcutLabel } from '@/hooks/useShortcutLabel'
import type { OpenFile } from '../../store/slices/editor'
import { translate } from '@/i18n/i18n'
import { LocalOnlyMenuHint } from '@/components/local-only-menu-hint'
import {
  getRevealInFileManagerLabel,
  getWorkspaceFileRevealOwner,
  revealInFileManager
} from '@/lib/reveal-in-file-manager'
import { isRevealOrEditorOpenBlocked } from '@/lib/local-path-open-guard'
import { formatClipboardFilePath } from '@/lib/clipboard-file-path'
import { TabWorkspaceLayoutMenuSection } from './TabWorkspaceLayoutMenuSection'
import { TAB_CONTEXT_MENU_CONTENT_CLASS } from './tab-context-menu-sizing'
import { CopyTabIdMenuItem } from './CopyTabIdMenuItem'
import { isVirtualEditorFile } from '@/store/slices/editor/tabs/editor-tab-content-type'
import { CloseSplitPaneMenuItem } from './CloseSplitPaneMenuItem'

type EditorFileTabContextMenuProps = {
  open: boolean
  menuPoint: { x: number; y: number }
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
  onOpenChange: (open: boolean) => void
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
  open,
  menuPoint,
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
  onOpenChange,
  onActivate,
  onOpenRenameInput,
  onTogglePin,
  onClose,
  onCloseOthers,
  onCloseAll,
  onCloseSplitPane,
  onOpenMarkdownPreview
}: EditorFileTabContextMenuProps): React.JSX.Element {
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
    <DropdownMenu open={open} onOpenChange={onOpenChange} modal={false}>
      <DropdownMenuTrigger asChild>
        <button
          aria-hidden
          tabIndex={-1}
          className="pointer-events-none fixed size-px opacity-0"
          style={{ left: menuPoint.x, top: menuPoint.y }}
        />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        className={TAB_CONTEXT_MENU_CONTENT_CLASS}
        sideOffset={0}
        align="start"
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
        <DropdownMenuItem
          disabled={!canRename || isRenaming}
          onSelect={() => {
            skipMenuFocusRestoreRef.current = true
          }}
        >
          <Pencil className="size-3.5" />
          {translate('auto.components.tab.bar.EditorFileTabContextMenu.68cc610e7f', 'Rename')}
          {renameShortcut ? <DropdownMenuShortcut>{renameShortcut}</DropdownMenuShortcut> : null}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={onTogglePin}>
          {isPinned ? <PinOff className="size-3.5" /> : <Pin className="size-3.5" />}
          {isPinned
            ? translate('auto.components.tab.bar.EditorFileTabContextMenu.8e9d603a09', 'Unpin Tab')
            : translate('auto.components.tab.bar.EditorFileTabContextMenu.fdd29eb669', 'Pin Tab')}
        </DropdownMenuItem>
        <CopyTabIdMenuItem unifiedTabId={unifiedTabId} />
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => !isPinned && onClose()} disabled={isPinned}>
          <X className="size-3.5" />
          {translate('auto.components.tab.bar.EditorFileTabContextMenu.1ba8492c5b', 'Close')}
          {closeShortcut ? <DropdownMenuShortcut>{closeShortcut}</DropdownMenuShortcut> : null}
        </DropdownMenuItem>
        <DropdownMenuItem inset onSelect={onCloseOthers} disabled={tabCount <= 1}>
          {translate('components.tab.bar.EditorFileTabContextMenu.closeOthers', 'Close Others')}
        </DropdownMenuItem>
        <DropdownMenuItem inset onSelect={onCloseAll}>
          {translate(
            'auto.components.tab.bar.EditorFileTabContextMenu.ba1369dd24',
            'Close All Editor Tabs'
          )}
          {closeAllShortcut ? (
            <DropdownMenuShortcut>{closeAllShortcut}</DropdownMenuShortcut>
          ) : null}
        </DropdownMenuItem>
        <CloseSplitPaneMenuItem onCloseSplitPane={onCloseSplitPane} />
        {isVirtualEditorFile(file) ? null : <DropdownMenuSeparator />}
        {canShowMarkdownPreview ? (
          <>
            <DropdownMenuItem
              inset
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
              {translate(
                'auto.components.tab.bar.EditorFileTabContextMenu.bfd5797ef4',
                'Open Markdown Preview'
              )}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
          </>
        ) : null}
        {/* Why: virtual editor tabs use synthetic ids instead of on-disk paths. */}
        {!isVirtualEditorFile(file) && (
          <>
            <DropdownMenuItem
              inset
              onSelect={() => {
                void window.api.ui.writeClipboardText(
                  formatClipboardFilePath(file.filePath, revealOwner)
                )
              }}
            >
              {translate(
                'auto.components.tab.bar.EditorFileTabContextMenu.5b85754786',
                'Copy Path'
              )}
            </DropdownMenuItem>
            <DropdownMenuItem
              inset
              onSelect={() => {
                void window.api.ui.writeClipboardText(file.relativePath)
              }}
            >
              {translate(
                'auto.components.tab.bar.EditorFileTabContextMenu.52ce4f4605',
                'Copy Relative Path'
              )}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              inset
              disabled={revealBlocked}
              onSelect={() => void revealInFileManager(file.filePath, revealOwner)}
            >
              {getRevealInFileManagerLabel()}
              {revealBlocked ? <LocalOnlyMenuHint /> : null}
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
