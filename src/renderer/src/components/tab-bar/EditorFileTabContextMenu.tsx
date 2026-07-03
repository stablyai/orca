import { Copy, ExternalLink, Pencil, Pin, PinOff } from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { useAppStore } from '@/store'
import { showLocalPathOpenBlockedToast } from '@/lib/local-path-open-guard'
import { useOptionalShortcutLabel } from '@/hooks/useShortcutLabel'
import type { OpenFile } from '../../store/slices/editor'
import { shouldBlockEditorTabLocalOpen } from './editor-tab-local-open-guard'
import { translate } from '@/i18n/i18n'
import { TabWorkspaceLayoutMenuSection } from './TabWorkspaceLayoutMenuSection'

const isMac = navigator.userAgent.includes('Mac')
const isLinux = navigator.userAgent.includes('Linux')

/** Platform-appropriate label: macOS → Finder, Windows → File Explorer, Linux → Files */
const revealLabel = isMac
  ? 'Reveal in Finder'
  : isLinux
    ? 'Open Containing Folder'
    : 'Reveal in File Explorer'

type EditorFileTabContextMenuProps = {
  open: boolean
  menuPoint: { x: number; y: number }
  file: OpenFile & { tabId?: string }
  unifiedTabId: string
  groupId: string
  isPinned: boolean
  isRenaming: boolean
  hasTabsToRight: boolean
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
  onCloseAll: () => void
  onCloseToRight: () => void
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
  onCloseAll,
  onCloseToRight,
  onOpenMarkdownPreview
}: EditorFileTabContextMenuProps): React.JSX.Element {
  const renameShortcut = useOptionalShortcutLabel('tab.rename')
  const closeShortcut = useOptionalShortcutLabel('tab.close')
  const closeAllShortcut = useOptionalShortcutLabel('tab.closeAll')

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
        className="w-48"
        sideOffset={0}
        align="start"
        onCloseAutoFocus={(event) => {
          if (!skipMenuFocusRestoreRef.current) {
            return
          }
          skipMenuFocusRestoreRef.current = false
          event.preventDefault()
        }}
      >
        <DropdownMenuItem
          disabled={!canRename || isRenaming}
          onSelect={() => {
            skipMenuFocusRestoreRef.current = true
            onActivate()
            onOpenRenameInput()
          }}
        >
          <Pencil className="mr-1.5 size-3.5" />
          {translate('auto.components.tab.bar.EditorFileTabContextMenu.68cc610e7f', 'Rename')}
          {renameShortcut ? <DropdownMenuShortcut>{renameShortcut}</DropdownMenuShortcut> : null}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={onTogglePin}>
          {isPinned ? <PinOff className="mr-1.5 size-3.5" /> : <Pin className="mr-1.5 size-3.5" />}
          {isPinned
            ? translate('auto.components.tab.bar.EditorFileTabContextMenu.8e9d603a09', 'Unpin Tab')
            : translate('auto.components.tab.bar.EditorFileTabContextMenu.fdd29eb669', 'Pin Tab')}
        </DropdownMenuItem>
        <TabWorkspaceLayoutMenuSection unifiedTabId={unifiedTabId} groupId={groupId} />
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => !isPinned && onClose()} disabled={isPinned}>
          {translate('auto.components.tab.bar.EditorFileTabContextMenu.1ba8492c5b', 'Close')}
          {closeShortcut ? <DropdownMenuShortcut>{closeShortcut}</DropdownMenuShortcut> : null}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={onCloseAll}>
          {translate(
            'auto.components.tab.bar.EditorFileTabContextMenu.ba1369dd24',
            'Close All Editor Tabs'
          )}
          {closeAllShortcut ? (
            <DropdownMenuShortcut>{closeAllShortcut}</DropdownMenuShortcut>
          ) : null}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={onCloseToRight} disabled={!hasTabsToRight}>
          {translate(
            'auto.components.tab.bar.EditorFileTabContextMenu.e5ff31ccaf',
            'Close Tabs To The Right'
          )}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
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
              {translate(
                'auto.components.tab.bar.EditorFileTabContextMenu.bfd5797ef4',
                'Open Markdown Preview'
              )}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
          </>
        ) : null}
        <DropdownMenuItem
          onSelect={() => {
            void window.api.ui.writeClipboardText(file.filePath)
          }}
        >
          <Copy className="w-3.5 h-3.5 mr-1.5" />
          {translate('auto.components.tab.bar.EditorFileTabContextMenu.5b85754786', 'Copy Path')}
        </DropdownMenuItem>
        <DropdownMenuItem
          onSelect={() => {
            void window.api.ui.writeClipboardText(file.relativePath)
          }}
        >
          <Copy className="w-3.5 h-3.5 mr-1.5" />
          {translate(
            'auto.components.tab.bar.EditorFileTabContextMenu.52ce4f4605',
            'Copy Relative Path'
          )}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onSelect={() => {
            if (
              shouldBlockEditorTabLocalOpen(
                useAppStore.getState().settings,
                file.runtimeEnvironmentId,
                repoConnectionId
              )
            ) {
              showLocalPathOpenBlockedToast()
              return
            }
            window.api.shell.openPath(file.filePath)
          }}
        >
          <ExternalLink className="w-3.5 h-3.5 mr-1.5" />
          {revealLabel}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
