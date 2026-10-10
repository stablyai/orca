import { ImeInput } from '@/lib/ime-text-field'
import { useEffect, useRef, useState } from 'react'
import { Copy, ExternalLink, Eye, Pencil } from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { useShortcutLabel } from '@/hooks/useShortcutLabel'
import { isImeCompositionKeyDown } from '@/lib/ime-composition-keyboard-event'
import { translate } from '@/i18n/i18n'
import { LocalOnlyMenuHint } from '@/components/local-only-menu-hint'
import { getConnectionIdFromState } from '@/lib/connection-context'
import {
  getRevealInFileManagerLabel,
  isRevealInFileManagerBlocked,
  revealInFileManager
} from '@/lib/reveal-in-file-manager'
import { useAppStore } from '@/store'
import type { OpenFile } from '@/store/slices/editor'
import { isVirtualEditorFile } from '@/store/slices/editor/tabs/editor-tab-content-type'
import { CLOSE_ALL_CONTEXT_MENUS_EVENT } from '@/lib/close-all-context-menus'
import { useEditorHeaderFileRename } from './editor-header-file-rename'
import { getEditorHeaderCopyState } from './editor-header'
import { splitPathForDisplay } from './editor-path-display'

type EditorPanelHeaderPathProps = {
  activeFile: OpenFile
  copiedPathVisible: boolean
  canShowMarkdownPreview: boolean
  onCopyPath: () => void
  onOpenMarkdownPreview: () => void
}

export function EditorPanelHeaderPath({
  activeFile,
  copiedPathVisible,
  canShowMarkdownPreview,
  onCopyPath,
  onOpenMarkdownPreview
}: EditorPanelHeaderPathProps): React.JSX.Element {
  const [pathMenuOpen, setPathMenuOpen] = useState(false)
  const [pathMenuPoint, setPathMenuPoint] = useState({ x: 0, y: 0 })
  const skipMenuFocusRestoreRef = useRef(false)
  const headerCopyState = getEditorHeaderCopyState(activeFile)
  const displayPath = splitPathForDisplay(headerCopyState.pathLabel)
  const canCopyHeaderPath = headerCopyState.copyText !== null
  // Why: virtual editor tabs use synthetic ids instead of on-disk paths.
  const isVirtualEditorTab = isVirtualEditorFile(activeFile)
  const revealBlocked = useAppStore((s) =>
    isRevealInFileManagerBlocked(s.settings, {
      connectionId:
        activeFile.externalSshTargetId ?? getConnectionIdFromState(s, activeFile.worktreeId),
      runtimeEnvironmentId: activeFile.runtimeEnvironmentId
    })
  )
  const markdownPreviewShortcutLabel = useShortcutLabel('editor.markdownPreview')
  const {
    canRename,
    currentFileName,
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
          <ImeInput
            ref={renameInputRef}
            data-editor-header-rename-input="true"
            aria-label={translate(
              'auto.components.editor.EditorPanelHeader.1bb1e226ec',
              'Rename file {{value0}}',
              { value0: currentFileName }
            )}
            defaultValue={currentFileName}
            // Why: the field spans the header rather than sizing to the name —
            // a long path is exactly when the rename field needs the room.
            className="h-6 w-full min-w-0 max-w-full rounded-md border border-accent/40 bg-input/40 px-1.5 font-mono text-xs text-foreground outline-none focus:border-accent focus:ring-1 focus:ring-ring"
            spellCheck={false}
            onPointerDown={(event) => event.stopPropagation()}
            onMouseDown={(event) => event.stopPropagation()}
            onClick={(event) => event.stopPropagation()}
            onDoubleClick={(event) => event.stopPropagation()}
            onKeyDown={(event) => {
              // Why: an Enter that only confirms a CJK IME candidate must not
              // commit the rename; wait for a non-composition Enter.
              if (isImeCompositionKeyDown(event)) {
                return
              }
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
        ) : (
          <button
            type="button"
            className={`editor-header-path${canCopyHeaderPath ? '' : ' editor-header-path--static'}`}
            onClick={canCopyHeaderPath ? onCopyPath : undefined}
            disabled={!canCopyHeaderPath}
            title={headerCopyState.pathTitle}
          >
            <span className="editor-header-path-prefix">{displayPath.prefix}</span>
            <span className="editor-header-path-file">{displayPath.fileName}</span>
          </button>
        )}
        {/* Why: the toast is opacity-0 rather than display-none, so leaving it
            mounted reserves ~100px of the row from the rename field for a
            message that cannot fire while renaming. */}
        {!isRenaming && (
          <span
            className={`editor-header-copy-toast${copiedPathVisible ? ' is-visible' : ''}`}
            aria-live="polite"
          >
            {headerCopyState.copyToastLabel}
          </span>
        )}
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
            <DropdownMenuItem
              disabled={revealBlocked}
              onSelect={() => void revealInFileManager(activeFile.filePath)}
            >
              <ExternalLink className="w-3.5 h-3.5 mr-1.5" />
              {getRevealInFileManagerLabel()}
              {revealBlocked ? <LocalOnlyMenuHint /> : null}
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}
