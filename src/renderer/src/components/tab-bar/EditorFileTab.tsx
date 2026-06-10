import { useCallback, useEffect, useRef, useState } from 'react'
import { useSortable } from '@dnd-kit/sortable'
import { X, GitCompareArrows, Eye, ShieldAlert, Pin } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { basename, normalizeRelativePath } from '@/lib/path'
import { getEditorDisplayLabel } from '@/components/editor/editor-labels'
import { renameFileOnDisk } from '@/lib/rename-file'
import { detectLanguage } from '@/lib/language-detect'
import { getFileTypeIcon } from '@/lib/file-type-icons'
import { useRepoById, useWorktreeById } from '@/store/selectors'
import { useAppStore } from '@/store'
import { STATUS_COLORS, STATUS_LABELS } from '../right-sidebar/status-display'
import type { GitFileStatus } from '../../../../shared/types'
import type { OpenFile } from '../../store/slices/editor'
import { getUntitledFileRoot } from '@/components/editor/untitled-file-rename-path'
import { preventMiddleButtonDefault } from './middle-button-default-guard'
import { CLOSE_ALL_CONTEXT_MENUS_EVENT } from './SortableTab'
import type { TabDragItemData } from '../tab-group/useTabDragSplit'
import {
  ACTIVE_TAB_INDICATOR_CLASSES,
  getDropIndicatorClasses,
  getTabRootStateClasses,
  getTabStripBorderClasses,
  type DropIndicator
} from './drop-indicator'
import { canOpenMarkdownPreview } from '@/components/editor/markdown-preview-controls'
import { EditorFileTabContextMenu } from './EditorFileTabContextMenu'
import { translate } from '@/i18n/i18n'

export default function EditorFileTab({
  file,
  isActive,
  isPinned,
  hasTabsToRight,
  statusByRelativePath,
  onActivate,
  onClose,
  onCloseToRight,
  onCloseAll,
  onMakePermanent,
  onTogglePin,
  onSplitGroup,
  dragData,
  dropIndicator,
  includeTopTabBorder = true
}: {
  file: OpenFile & { tabId?: string }
  isActive: boolean
  isPinned: boolean
  hasTabsToRight: boolean
  statusByRelativePath: Map<string, GitFileStatus>
  onActivate: () => void
  onClose: () => void
  onCloseToRight: () => void
  onCloseAll: () => void
  onMakePermanent?: () => void
  onTogglePin: () => void
  onSplitGroup: (direction: 'left' | 'right' | 'up' | 'down', sourceVisibleTabId: string) => void
  dragData: TabDragItemData
  dropIndicator?: DropIndicator
  includeTopTabBorder?: boolean
}): React.JSX.Element {
  const worktree = useWorktreeById(file.worktreeId)
  const repo = useRepoById(worktree?.repoId ?? null)
  const FileIcon = getFileTypeIcon(file.filePath)
  // Why: no transform/transition/isDragging styling — the drag design is
  // that tabs stay visually anchored; only the blue insertion bar moves.
  const { attributes, listeners, setNodeRef } = useSortable({
    // Why: split groups can duplicate the same open file into multiple visible
    // tabs. Using the unified tab ID keeps each rendered tab draggable as a
    // distinct item instead of collapsing every copy onto the file entity ID.
    id: file.tabId ?? file.id,
    data: dragData
  })

  const isDiff = file.mode === 'diff'
  const isConflictReview = file.mode === 'conflict-review'
  const isMarkdownPreviewTab = file.mode === 'markdown-preview'
  const resolvedLanguage =
    file.mode === 'diff'
      ? detectLanguage(file.relativePath)
      : isConflictReview
        ? 'plaintext'
        : file.language
  const canShowMarkdownPreview = canOpenMarkdownPreview({
    language: resolvedLanguage,
    mode: file.mode,
    diffSource: file.diffSource
  })
  const openMarkdownPreview = useAppStore((s) => s.openMarkdownPreview)
  const [menuOpen, setMenuOpen] = useState(false)
  const [menuPoint, setMenuPoint] = useState({ x: 0, y: 0 })
  const [isRenaming, setIsRenaming] = useState(false)
  const renameInputRef = useRef<HTMLInputElement>(null)
  const renameFocusFrameRef = useRef<number | null>(null)
  const skipMenuFocusRestoreRef = useRef(false)
  // Escape fires setIsRenaming(false), which unmounts the input. The browser
  // still fires focusout as the focused node is removed, so onBlur can invoke
  // commitRename *after* cancel — committing the typed value against the
  // user's intent. This flag suppresses the trailing blur-commit.
  const renameCancelledRef = useRef(false)
  // Only on-disk edit tabs are renameable. Diff, conflict-review, and
  // combined/virtual views don't point at a single concrete file we can safely rename.
  const canRename = file.mode === 'edit' && !file.diffSource && !file.conflict

  const openRenameInput = (): void => {
    if (!canRename) {
      return
    }
    renameCancelledRef.current = false
    setIsRenaming(true)
  }

  const commitRename = (): void => {
    if (renameCancelledRef.current) {
      renameCancelledRef.current = false
      setIsRenaming(false)
      return
    }
    const input = renameInputRef.current
    if (!input) {
      setIsRenaming(false)
      return
    }
    const newName = input.value.trim()
    setIsRenaming(false)
    if (!newName) {
      return
    }
    const oldName = basename(file.filePath)
    if (newName === oldName) {
      return
    }
    const worktreePath = getUntitledFileRoot(file, worktree?.path ?? null)
    void renameFileOnDisk({
      oldPath: file.filePath,
      newName,
      worktreeId: file.worktreeId,
      worktreePath
    })
  }

  const setRenameInputElement = useCallback(
    (input: HTMLInputElement | null) => {
      if (renameFocusFrameRef.current !== null) {
        cancelAnimationFrame(renameFocusFrameRef.current)
        renameFocusFrameRef.current = null
      }
      renameInputRef.current = input
      if (!input) {
        return
      }
      // Why: Radix closes the context menu after onSelect; defer focus so its
      // teardown cannot steal focus back or blur-commit the newly mounted input.
      renameFocusFrameRef.current = requestAnimationFrame(() => {
        renameFocusFrameRef.current = null
        if (renameInputRef.current !== input) {
          return
        }
        input.focus()
        const name = basename(file.filePath)
        const dotIndex = name.lastIndexOf('.')
        if (dotIndex > 0) {
          input.setSelectionRange(0, dotIndex)
        } else {
          input.select()
        }
      })
    },
    [file.filePath]
  )

  const tabStatus =
    file.relativePath === 'All Changes'
      ? null
      : (statusByRelativePath.get(normalizeRelativePath(file.relativePath)) ?? null)
  const tabStatusColor = tabStatus ? STATUS_COLORS[tabStatus] : undefined
  const tabLabel = getEditorDisplayLabel(file)

  useEffect(() => {
    const closeMenu = (): void => setMenuOpen(false)
    window.addEventListener(CLOSE_ALL_CONTEXT_MENUS_EVENT, closeMenu)
    return () => window.removeEventListener(CLOSE_ALL_CONTEXT_MENUS_EVENT, closeMenu)
  }, [])

  // Why: Electron <webview> elements run in a separate process, so clicking
  // inside one never dispatches a pointerdown on the renderer document. Radix
  // DropdownMenu relies on document pointerdown for outside-click detection,
  // so it misses webview clicks. Listening for window blur catches the moment
  // focus leaves the renderer (including into a webview).
  useEffect(() => {
    if (!menuOpen) {
      return
    }
    const dismiss = (): void => setMenuOpen(false)
    window.addEventListener('blur', dismiss)
    return () => window.removeEventListener('blur', dismiss)
  }, [menuOpen])

  const tabRoot = (
    <div
      ref={setNodeRef}
      data-pinned={isPinned ? 'true' : 'false'}
      {...attributes}
      {...listeners}
      className={`group relative flex items-center h-full px-1.5 text-xs cursor-pointer select-none shrink-0 outline-none focus:outline-none focus-visible:outline-none ${getTabStripBorderClasses(hasTabsToRight, { includeTopBorder: includeTopTabBorder })} ${getDropIndicatorClasses(dropIndicator ?? null)} ${getTabRootStateClasses(isActive)}`}
      onPointerDown={(e) => {
        if (e.button !== 0) {
          return
        }
        onActivate()
        listeners?.onPointerDown?.(e)
      }}
      onDoubleClick={() => {
        if (file.isPreview && onMakePermanent) {
          onMakePermanent()
        }
      }}
      onMouseDown={(e) => {
        if (e.button === 1) {
          e.preventDefault()
        }
      }}
      onMouseUp={preventMiddleButtonDefault}
      onAuxClick={(e) => {
        if (e.button === 1) {
          e.preventDefault()
          e.stopPropagation()
          if (isPinned) {
            return
          }
          onClose()
        }
      }}
    >
      {isActive && <span className={ACTIVE_TAB_INDICATOR_CLASSES} aria-hidden />}
      {isConflictReview ? (
        <ShieldAlert
          className={`w-3 h-3 mr-1 shrink-0 ${isActive ? 'text-orange-400' : 'text-orange-400/70'}`}
        />
      ) : isDiff ? (
        <GitCompareArrows
          className={`w-3 h-3 mr-1 shrink-0 ${isActive ? 'text-foreground' : 'text-muted-foreground'}`}
        />
      ) : isMarkdownPreviewTab ? (
        <Eye
          className={`w-3.5 h-3.5 mr-1.5 shrink-0 ${isActive ? 'text-foreground' : 'text-muted-foreground'}`}
        />
      ) : (
        <FileIcon
          className={`w-3 h-3 mr-1 shrink-0 ${isActive ? 'text-foreground' : 'text-muted-foreground'}`}
        />
      )}
      {isPinned && <Pin className="mr-1 size-3 shrink-0 text-muted-foreground" aria-hidden />}
      <span className="mr-1 flex min-w-0 items-baseline gap-1">
        {isRenaming ? (
          <Input
            ref={setRenameInputElement}
            data-tab-rename-input="true"
            aria-label={translate(
              'auto.components.tab.bar.EditorFileTab.3da7445c84',
              'Rename file {{value0}}',
              { value0: basename(file.filePath) }
            )}
            defaultValue={basename(file.filePath)}
            // Why: keep the inline field compact enough for the titlebar while
            // giving filenames a little more room than the static tab label.
            className="mr-1 h-5 w-[12ch] min-w-[72px] max-w-[132px] rounded-sm bg-input/40 px-1 py-0 text-xs text-foreground md:text-xs focus-visible:ring-[1px]"
            spellCheck={false}
            onPointerDown={(e) => e.stopPropagation()}
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => e.stopPropagation()}
            onDoubleClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                e.stopPropagation()
                commitRename()
              } else if (e.key === 'Escape') {
                e.preventDefault()
                e.stopPropagation()
                renameCancelledRef.current = true
                setIsRenaming(false)
              }
            }}
            onBlur={commitRename}
          />
        ) : (
          <span
            className={`truncate max-w-[80px]${file.isPreview ? ' italic' : ''}${file.externalMutation ? ' line-through' : ''}`}
            style={tabStatusColor ? { color: tabStatusColor } : undefined}
            onDoubleClick={(e) => {
              if (file.isPreview && onMakePermanent) {
                e.stopPropagation()
                onMakePermanent()
                return
              }
              // Why: preview tabs use double-click to become permanent. Scope
              // rename to non-preview filename text so preview promotion wins on
              // the tab label as well as the surrounding tab chrome.
              if (!canRename) {
                return
              }
              e.stopPropagation()
              openRenameInput()
            }}
          >
            {tabLabel}
          </span>
        )}
        {file.externalMutation && !isRenaming && (
          <span className="shrink-0 text-[10px] leading-none font-semibold tracking-wide text-muted-foreground">
            {file.externalMutation}
          </span>
        )}
        {tabStatus && !isRenaming && !file.externalMutation && (
          <span
            className="shrink-0 text-[10px] leading-none font-semibold tracking-wide"
            style={{ color: tabStatusColor }}
          >
            {STATUS_LABELS[tabStatus]}
          </span>
        )}
      </span>
      {/* Dirty dot and close button share the same slot to prevent tab width shift during auto-save.
         When dirty: dot is shown, close button appears on hover (replacing the dot).
         When clean: close button is shown normally (visible on active tab, on hover for others). */}
      <div className="relative flex items-center justify-center w-4 h-4 shrink-0">
        {file.isDirty && (
          <span className="absolute size-1.5 rounded-full bg-foreground/60 group-hover:hidden" />
        )}
        {!isPinned && (
          <button
            className={`flex items-center justify-center w-4 h-4 rounded-sm ${
              file.isDirty
                ? 'hidden group-hover:flex text-muted-foreground hover:text-foreground hover:bg-muted'
                : isActive
                  ? 'text-muted-foreground hover:text-foreground hover:bg-muted'
                  : 'text-transparent group-hover:text-muted-foreground hover:!text-foreground hover:!bg-muted'
            }`}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation()
              onClose()
            }}
          >
            <X className="w-3 h-3" />
          </button>
        )}
      </div>
    </div>
  )

  return (
    <>
      <div
        onContextMenuCapture={(event) => {
          event.preventDefault()
          window.dispatchEvent(new Event(CLOSE_ALL_CONTEXT_MENUS_EVENT))
          setMenuPoint({ x: event.clientX, y: event.clientY })
          setMenuOpen(true)
        }}
      >
        {isRenaming || menuOpen ? (
          tabRoot
        ) : (
          <Tooltip>
            <TooltipTrigger asChild>{tabRoot}</TooltipTrigger>
            <TooltipContent
              side="bottom"
              sideOffset={6}
              className="max-w-80 whitespace-normal break-words text-left"
            >
              {tabLabel}
            </TooltipContent>
          </Tooltip>
        )}
      </div>

      <EditorFileTabContextMenu
        open={menuOpen}
        menuPoint={menuPoint}
        file={file}
        isPinned={isPinned}
        isRenaming={isRenaming}
        hasTabsToRight={hasTabsToRight}
        canRename={canRename}
        canShowMarkdownPreview={canShowMarkdownPreview}
        resolvedLanguage={resolvedLanguage}
        repoConnectionId={repo?.connectionId ?? null}
        skipMenuFocusRestoreRef={skipMenuFocusRestoreRef}
        onOpenChange={setMenuOpen}
        onActivate={onActivate}
        onOpenRenameInput={openRenameInput}
        onTogglePin={onTogglePin}
        onClose={onClose}
        onCloseAll={onCloseAll}
        onCloseToRight={onCloseToRight}
        onSplitGroup={onSplitGroup}
        onOpenMarkdownPreview={openMarkdownPreview}
      />
    </>
  )
}
