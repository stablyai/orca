import { useCallback, useEffect, useRef, useState } from 'react'
import { useSortable } from '@dnd-kit/sortable'
import { Pin } from 'lucide-react'
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
import type { TabSplitDirection } from '../../store/slices/tabs'
import { canOpenMarkdownPreview } from '@/components/editor/markdown-preview-controls'
import { EditorFileTabContextMenu } from './EditorFileTabContextMenu'
import { TAB_CONTAINER_WIDTH_CLASSES, TAB_LABEL_WIDTH_CLASSES } from './tab-width-rules'
import { EditorFileTabCloseButton } from './EditorFileTabCloseButton'
import { EditorFileTabIcon } from './EditorFileTabIcon'
import { EditorFileTabRenameInput } from './EditorFileTabRenameInput'
import { useTabStripPointerActivation } from './tab-strip-pointer-activation'
export default function EditorFileTab({
  file,
  isActive,
  isPinned,
  hasTabsToRight,
  hasTabsToLeft,
  tabCount,
  statusByRelativePath,
  onActivate,
  onClose,
  onCloseOthers,
  onCloseToRight,
  onCloseToLeft,
  onCloseAll,
  onMakePermanent,
  onTogglePin,
  dragData,
  dropIndicator,
  includeTopTabBorder = true,
  isSelected = false,
  isMultiSelect = false,
  allSelectedPinned = false,
  onTogglePinSelected,
  onCloseSelected,
  onMoveSelectedToSplit,
  onContextMenuRequest
}: {
  file: OpenFile & { tabId?: string }
  isActive: boolean
  isPinned: boolean
  hasTabsToRight: boolean
  hasTabsToLeft: boolean
  tabCount: number
  statusByRelativePath: Map<string, GitFileStatus>
  onActivate: (event?: PointerEvent) => void
  onClose: () => void
  onCloseOthers: () => void
  onCloseToRight: () => void
  onCloseToLeft: () => void
  onCloseAll: () => void
  onMakePermanent?: () => void
  onTogglePin: () => void
  dragData: TabDragItemData
  dropIndicator?: DropIndicator
  includeTopTabBorder?: boolean
  isSelected?: boolean
  isMultiSelect?: boolean
  allSelectedPinned?: boolean
  onTogglePinSelected?: () => void
  onCloseSelected?: () => void
  onMoveSelectedToSplit?: (direction: TabSplitDirection) => void
  onContextMenuRequest?: (tabId: string) => void
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
  const isMissingFileMutation =
    file.externalMutation === 'deleted' || file.externalMutation === 'renamed'
  const resolvedLanguage = isDiff
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
  const canRename = file.mode === 'edit' && !file.diffSource && !file.conflict && !file.readOnly

  const openRenameInput = (): void => {
    if (canRename) {
      renameCancelledRef.current = false
      setIsRenaming(true)
    }
  }

  const commitRename = (): void => {
    if (renameCancelledRef.current) {
      renameCancelledRef.current = false
      setIsRenaming(false)
      return
    }
    const input = renameInputRef.current
    setIsRenaming(false)
    if (!input) {
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
  const dragListeners = isRenaming ? undefined : listeners
  // Why: defer activation to pointer-up so dragging the tab (reorder / move into
  // another pane / split) does not switch the active tab mid-gesture.
  const { onPointerDown: onTabPointerDown } = useTabStripPointerActivation({
    onActivate,
    disabled: isRenaming
  })

  const tabRoot = (
    <div
      ref={setNodeRef}
      data-tab-id={file.tabId ?? file.id}
      data-pinned={isPinned ? 'true' : 'false'}
      data-active={isActive ? 'true' : 'false'}
      data-selected={isSelected || isActive ? 'true' : 'false'}
      {...attributes}
      {...dragListeners}
      className={`group relative flex items-center h-full px-1.5 text-xs cursor-pointer select-none outline-none focus:outline-none focus-visible:outline-none ${getTabStripBorderClasses(hasTabsToRight, { includeTopBorder: includeTopTabBorder })} ${getDropIndicatorClasses(dropIndicator ?? null)} ${getTabRootStateClasses(isActive, isSelected)}`}
      onPointerDown={(e) =>
        onTabPointerDown(
          e,
          dragListeners?.onPointerDown as ((event: React.PointerEvent<Element>) => void) | undefined
        )
      }
      onDoubleClick={() => file.isPreview && onMakePermanent && onMakePermanent()}
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
      <EditorFileTabIcon mode={file.mode} isActive={isActive} FileIcon={FileIcon} />
      {isPinned && <Pin className="mr-1 size-3 shrink-0 text-muted-foreground" aria-hidden />}
      <span className="mr-1 flex min-w-0 flex-1 items-baseline gap-1">
        {isRenaming ? (
          <EditorFileTabRenameInput
            filePath={file.filePath}
            setInputElement={setRenameInputElement}
            onCommit={commitRename}
            onCancel={() => {
              renameCancelledRef.current = true
              setIsRenaming(false)
            }}
          />
        ) : (
          <span
            className={`${TAB_LABEL_WIDTH_CLASSES}${file.isPreview ? ' italic' : ''}${isMissingFileMutation ? ' line-through' : ''}`}
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
        {isMissingFileMutation && !isRenaming && (
          <span className="shrink-0 text-[10px] leading-none font-semibold tracking-wide text-muted-foreground">
            {file.externalMutation}
          </span>
        )}
        {tabStatus && !isRenaming && !isMissingFileMutation && (
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
          <span className="absolute size-1.5 rounded-full bg-foreground/60 group-hover:hidden group-focus-within:hidden" />
        )}
        {!isPinned && (
          <EditorFileTabCloseButton
            fileIsDirty={file.isDirty}
            showsSelectionChrome={isActive}
            onClose={onClose}
          />
        )}
      </div>
    </div>
  )

  return (
    <>
      <div
        className={TAB_CONTAINER_WIDTH_CLASSES}
        onContextMenuCapture={(event) => {
          event.preventDefault()
          onContextMenuRequest?.(file.tabId ?? file.id)
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
        unifiedTabId={dragData.unifiedTabId}
        groupId={dragData.groupId}
        isPinned={isPinned}
        isRenaming={isRenaming}
        hasTabsToRight={hasTabsToRight}
        hasTabsToLeft={hasTabsToLeft}
        tabCount={tabCount}
        canRename={canRename}
        canShowMarkdownPreview={canShowMarkdownPreview}
        resolvedLanguage={resolvedLanguage}
        repoConnectionId={repo?.connectionId ?? null}
        skipMenuFocusRestoreRef={skipMenuFocusRestoreRef}
        onOpenChange={setMenuOpen}
        onActivate={() => onActivate()}
        onOpenRenameInput={openRenameInput}
        onTogglePin={onTogglePin}
        onClose={onClose}
        onCloseOthers={onCloseOthers}
        onCloseAll={onCloseAll}
        onCloseToRight={onCloseToRight}
        onCloseToLeft={onCloseToLeft}
        onOpenMarkdownPreview={openMarkdownPreview}
        isMultiSelect={isMultiSelect}
        allSelectedPinned={allSelectedPinned}
        onTogglePinSelected={onTogglePinSelected}
        onCloseSelected={onCloseSelected}
        onMoveSelectedToSplit={onMoveSelectedToSplit}
      />
    </>
  )
}
