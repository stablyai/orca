import {
  Copy,
  CopyX,
  ExternalLink,
  Eye,
  ListX,
  PanelLeftClose,
  PanelRightClose,
  Pencil,
  Pin,
  PinOff,
  X
} from 'lucide-react'
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
  isRevealInFileManagerBlocked,
  revealInFileManager
} from '@/lib/reveal-in-file-manager'
import { TabWorkspaceLayoutMenuSection } from './TabWorkspaceLayoutMenuSection'
import { TAB_CONTEXT_MENU_CONTENT_CLASS } from './tab-context-menu-sizing'
import { isVirtualEditorFile } from '@/store/slices/editor/tabs/editor-tab-content-type'

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
  hasTabsToRight,
  hasTabsToLeft,
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
  onCloseToRight,
  onCloseToLeft,
  onOpenMarkdownPreview
}: EditorFileTabContextMenuProps): React.JSX.Element {
  const renameShortcut = useOptionalShortcutLabel('tab.rename')
  const closeShortcut = useOptionalShortcutLabel('tab.close')
  const closeAllShortcut = useOptionalShortcutLabel('tab.closeAll')
  const revealBlocked = useAppStore((s) =>
    isRevealInFileManagerBlocked(s.settings, {
      connectionId: file.externalSshTargetId ?? repoConnectionId,
      runtimeEnvironmentId: file.runtimeEnvironmentId
    })
  )

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
          // Why: opening the input in onSelect lets the still-closing menu reclaim
          // focus, and the resulting blur commits the rename away before the user types.
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
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => !isPinned && onClose()} disabled={isPinned}>
          <X className="size-3.5" />
          {translate('auto.components.tab.bar.EditorFileTabContextMenu.1ba8492c5b', 'Close')}
          {closeShortcut ? <DropdownMenuShortcut>{closeShortcut}</DropdownMenuShortcut> : null}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={onCloseOthers} disabled={tabCount <= 1}>
          <CopyX className="size-3.5" />
          {translate('components.tab.bar.EditorFileTabContextMenu.closeOthers', 'Close Others')}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={onCloseAll}>
          <ListX className="size-3.5" />
          {translate(
            'auto.components.tab.bar.EditorFileTabContextMenu.ba1369dd24',
            'Close All Editor Tabs'
          )}
          {closeAllShortcut ? (
            <DropdownMenuShortcut>{closeAllShortcut}</DropdownMenuShortcut>
          ) : null}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={onCloseToRight} disabled={!hasTabsToRight}>
          <PanelRightClose className="size-3.5" />
          {translate(
            'auto.components.tab.bar.EditorFileTabContextMenu.e5ff31ccaf',
            'Close Tabs To The Right'
          )}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={onCloseToLeft} disabled={!hasTabsToLeft}>
          <PanelLeftClose className="size-3.5" />
          {translate(
            'components.tab.bar.EditorFileTabContextMenu.closeTabsToLeft',
            'Close Tabs To The Left'
          )}
        </DropdownMenuItem>
        {isVirtualEditorFile(file) ? null : <DropdownMenuSeparator />}
        {canShowMarkdownPreview ? (
          <>
            <DropdownMenuItem
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
              onSelect={() => {
                void window.api.ui.writeClipboardText(file.filePath)
              }}
            >
              <Copy className="size-3.5" />
              {translate(
                'auto.components.tab.bar.EditorFileTabContextMenu.5b85754786',
                'Copy Path'
              )}
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() => {
                void window.api.ui.writeClipboardText(file.relativePath)
              }}
            >
              <Copy className="size-3.5" />
              {translate(
                'auto.components.tab.bar.EditorFileTabContextMenu.52ce4f4605',
                'Copy Relative Path'
              )}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              disabled={revealBlocked}
              onSelect={() => void revealInFileManager(file.filePath)}
            >
              <ExternalLink className="size-3.5" />
              {getRevealInFileManagerLabel()}
              {revealBlocked ? <LocalOnlyMenuHint /> : null}
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
