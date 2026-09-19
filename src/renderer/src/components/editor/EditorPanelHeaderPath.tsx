import { useEffect, useRef, useState } from 'react'
import { Check, Copy, ExternalLink, Eye, Pencil, X } from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { useShortcutLabel } from '@/hooks/useShortcutLabel'
import { translate } from '@/i18n/i18n'
import type { OpenFile } from '@/store/slices/editor'
import { CLOSE_ALL_CONTEXT_MENUS_EVENT } from '../tab-bar/SortableTab'
import { useEditorHeaderFileRename } from './editor-header-file-rename'
import { getEditorHeaderCopyState } from './editor-header'

const isMac = navigator.userAgent.includes('Mac')
const isLinux = navigator.userAgent.includes('Linux')

/** Platform-appropriate label: macOS -> Finder, Windows -> File Explorer, Linux -> Files */
function getRevealLabel(): string {
  return isMac
    ? translate('auto.components.editor.EditorPanelHeader.revealInFinder', 'Reveal in Finder')
    : isLinux
      ? translate(
          'auto.components.editor.EditorPanelHeader.openContainingFolder',
          'Open Containing Folder'
        )
      : translate(
          'auto.components.editor.EditorPanelHeader.revealInFileExplorer',
          'Reveal in File Explorer'
        )
}

type EditorPanelHeaderPathProps = {
  activeFile: OpenFile
  copiedPathVisible: boolean
  canShowMarkdownPreview: boolean
  onCopyPath: () => void
  onOpenMarkdownPreview: () => void
  onOpenContainingFolder: () => void
}

export function EditorPanelHeaderPath({
  activeFile,
  copiedPathVisible,
  canShowMarkdownPreview,
  onCopyPath,
  onOpenMarkdownPreview,
  onOpenContainingFolder
}: EditorPanelHeaderPathProps): React.JSX.Element {
  const [pathMenuOpen, setPathMenuOpen] = useState(false)
  const [pathMenuPoint, setPathMenuPoint] = useState({ x: 0, y: 0 })
  const skipMenuFocusRestoreRef = useRef(false)
  const headerCopyState = getEditorHeaderCopyState(activeFile)
  const canCopyHeaderPath = headerCopyState.copyText !== null
  const isVirtualEditorTab = activeFile.mode === 'check-details'
  const markdownPreviewShortcutLabel = useShortcutLabel('editor.markdownPreview')
  const {
    canRename,
    currentFileName,
    currentBaseName,
    currentExtension,
    breadcrumbSegments,
    isRenaming,
    renameInputRef,
    openRenameInput,
    commitRename,
    cancelRename
  } = useEditorHeaderFileRename(activeFile)

  useEffect(() => {
    const closeMenu = (): void => setPathMenuOpen(false)
    window.addEventListener(CLOSE_ALL_CONTEXT_MENUS_EVENT, closeMenu)
    return () => window.removeEventListener(CLOSE_ALL_CONTEXT_MENUS_EVENT, closeMenu)
  }, [])

  return (
    <div className="editor-header-text">
      <div
        className="editor-header-path-row"
        onContextMenuCapture={(event) => {
          event.preventDefault()
          window.dispatchEvent(new Event(CLOSE_ALL_CONTEXT_MENUS_EVENT))
          setPathMenuPoint({ x: event.clientX, y: event.clientY })
          setPathMenuOpen(true)
        }}
      >
        {isRenaming ? (
          <div className="flex h-6 w-full min-w-0 max-w-full items-center gap-1 rounded-md border border-accent/40 bg-input/40 py-0.5 pl-1.5 pr-1 focus-within:border-accent focus-within:ring-1 focus-within:ring-ring">
            {breadcrumbSegments.length > 0 ? (
              <span className="min-w-0 shrink truncate font-mono text-xs text-muted-foreground">
                {breadcrumbSegments.join(' / ')} /
              </span>
            ) : null}
            <input
              ref={renameInputRef}
              data-editor-header-rename-input="true"
              aria-label={translate(
                'auto.components.editor.EditorPanelHeader.1bb1e226ec',
                'Rename file {{value0}}',
                { value0: currentFileName }
              )}
              defaultValue={currentBaseName}
              className="h-full min-w-0 flex-1 bg-transparent font-mono text-xs font-semibold text-foreground outline-none"
              spellCheck={false}
              onPointerDown={(event) => event.stopPropagation()}
              onMouseDown={(event) => event.stopPropagation()}
              onClick={(event) => event.stopPropagation()}
              onDoubleClick={(event) => event.stopPropagation()}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  event.stopPropagation()
                  commitRename()
                } else if (event.key === 'Escape') {
                  event.preventDefault()
                  event.stopPropagation()
                  cancelRename()
                }
              }}
              onBlur={commitRename}
            />
            {currentExtension ? (
              <span className="shrink-0 font-mono text-xs text-muted-foreground">
                {currentExtension}
              </span>
            ) : null}
            <div className="flex shrink-0 items-center">
              <button
                type="button"
                aria-label={translate(
                  'auto.components.editor.EditorPanelHeader.confirmRename',
                  'Confirm rename'
                )}
                title={translate(
                  'auto.components.editor.EditorPanelHeader.confirmRename',
                  'Confirm rename'
                )}
                className="flex size-5 items-center justify-center rounded text-status-success hover:bg-status-success-background"
                onMouseDown={(event) => {
                  // Why: preventDefault keeps focus in the input so clicking
                  // confirm does not blur-commit first and double-rename.
                  event.preventDefault()
                  event.stopPropagation()
                }}
                onClick={(event) => {
                  event.stopPropagation()
                  commitRename()
                }}
              >
                <Check className="size-3" strokeWidth={3} aria-hidden="true" />
              </button>
              <button
                type="button"
                aria-label={translate(
                  'auto.components.editor.EditorPanelHeader.cancelRename',
                  'Cancel rename'
                )}
                title={translate(
                  'auto.components.editor.EditorPanelHeader.cancelRename',
                  'Cancel rename'
                )}
                className="flex size-5 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
                onMouseDown={(event) => {
                  // Why: same as confirm — cancel must win over the input's
                  // blur-commit when the pointer leaves the field.
                  event.preventDefault()
                  event.stopPropagation()
                }}
                onClick={(event) => {
                  event.stopPropagation()
                  cancelRename()
                }}
              >
                <X className="size-3" strokeWidth={3} aria-hidden="true" />
              </button>
            </div>
          </div>
        ) : (
          <button
            type="button"
            className={`editor-header-path${canCopyHeaderPath ? '' : ' editor-header-path--static'}`}
            onClick={canCopyHeaderPath ? onCopyPath : undefined}
            disabled={!canCopyHeaderPath}
            title={headerCopyState.pathTitle}
          >
            {headerCopyState.pathLabel}
          </button>
        )}
        <span
          className={`editor-header-copy-toast${copiedPathVisible ? ' is-visible' : ''}`}
          aria-live="polite"
        >
          {headerCopyState.copyToastLabel}
        </span>
      </div>
      <DropdownMenu open={pathMenuOpen} onOpenChange={setPathMenuOpen} modal={false}>
        <DropdownMenuTrigger asChild>
          <button
            aria-hidden
            tabIndex={-1}
            className="pointer-events-none fixed size-px opacity-0"
            style={{ left: pathMenuPoint.x, top: pathMenuPoint.y }}
          />
        </DropdownMenuTrigger>
        <DropdownMenuContent
          className="w-56"
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
            disabled={!canRename}
            onSelect={() => {
              skipMenuFocusRestoreRef.current = true
              openRenameInput()
            }}
          >
            <Pencil className="w-3.5 h-3.5 mr-1.5" />
            {translate('auto.components.editor.EditorPanelHeader.84cdc0794b', 'Rename')}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          {!isVirtualEditorTab && (
            <>
              <DropdownMenuItem
                onSelect={() => {
                  void window.api.ui.writeClipboardText(activeFile.filePath)
                }}
              >
                <Copy className="w-3.5 h-3.5 mr-1.5" />
                {translate('auto.components.editor.EditorPanelHeader.7c08a1f990', 'Copy Path')}
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={() => {
                  void window.api.ui.writeClipboardText(activeFile.relativePath)
                }}
              >
                <Copy className="w-3.5 h-3.5 mr-1.5" />
                {translate(
                  'auto.components.editor.EditorPanelHeader.269ce4842b',
                  'Copy Relative Path'
                )}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
            </>
          )}
          {canShowMarkdownPreview && (
            <DropdownMenuItem onSelect={onOpenMarkdownPreview}>
              <Eye className="w-3.5 h-3.5 mr-1.5" />
              {translate(
                'auto.components.editor.EditorPanelHeader.4157f3cbf3',
                'Open Markdown Preview'
              )}
              <DropdownMenuShortcut>{markdownPreviewShortcutLabel}</DropdownMenuShortcut>
            </DropdownMenuItem>
          )}
          {canShowMarkdownPreview && <DropdownMenuSeparator />}
          {!isVirtualEditorTab && (
            <DropdownMenuItem onSelect={onOpenContainingFolder}>
              <ExternalLink className="w-3.5 h-3.5 mr-1.5" />
              {getRevealLabel()}
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}
