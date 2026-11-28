import React, { Suspense, useCallback, useEffect, useRef, useState } from 'react'
import { lazyWithRetry as lazy } from '@/app-shell/startup/lazy-with-retry'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/class-names'
import { useTranslate } from '@/i18n/use-translate'

const WorktreeTitleInlineRenameEditor = lazy(() =>
  import('./WorktreeTitleInlineRenameEditor').then((module) => ({
    default: module.WorktreeTitleInlineRenameEditor
  }))
)

export type WorktreeTitleRenameCommit = { kind: 'cancel' } | { kind: 'save'; displayName: string }

export function getWorktreeTitleRenameCommit(
  currentDisplayName: string,
  nextDisplayName: string
): WorktreeTitleRenameCommit {
  const trimmed = nextDisplayName.trim()
  if (!trimmed || trimmed === currentDisplayName) {
    return { kind: 'cancel' }
  }
  return { kind: 'save', displayName: trimmed }
}

export function isWorktreeTitleTruncated(
  element: Pick<HTMLElement, 'clientWidth' | 'scrollWidth'>
): boolean {
  return element.scrollWidth > element.clientWidth
}

type WorktreeTitleInlineRenameProps = {
  displayName: string
  disabled?: boolean
  showUnreadEmphasis?: boolean
  dimReadTitle?: boolean
  editingPresentation?: 'text' | 'field'
  className?: string
  editingClassName?: string
  inputClassName?: string
  titleWrapper?: (title: React.ReactElement) => React.ReactElement
  wrapTitle?: boolean
  onEditingChange?: (editing: boolean) => void
  onRename: (displayName: string) => Promise<void> | void
  // Parents request editing once and clear the trigger through onBeginEditingConsumed.
  beginEditing?: boolean
  onBeginEditingConsumed?: () => void
}

export function WorktreeTitleInlineRename({
  displayName,
  disabled = false,
  showUnreadEmphasis = false,
  dimReadTitle = false,
  editingPresentation = 'text',
  className,
  editingClassName,
  inputClassName,
  titleWrapper,
  wrapTitle = false,
  onEditingChange,
  onRename,
  beginEditing = false,
  onBeginEditingConsumed
}: WorktreeTitleInlineRenameProps): React.JSX.Element {
  const t = useTranslate()
  const editingRef = useRef(false)
  const titleResizeObserverRef = useRef<ResizeObserver | null>(null)
  const removeTitleResizeListenerRef = useRef<(() => void) | null>(null)
  const [editing, setEditing] = useState(false)
  const [titleTruncated, setTitleTruncated] = useState(false)

  const measureTitleTruncated = useCallback((element: HTMLSpanElement | null) => {
    const nextTruncated = element ? isWorktreeTitleTruncated(element) : false
    setTitleTruncated((current) => (current === nextTruncated ? current : nextTruncated))
  }, [])

  const handleRootRef = useCallback(
    (node: HTMLSpanElement | null): void => {
      titleResizeObserverRef.current?.disconnect()
      titleResizeObserverRef.current = null
      removeTitleResizeListenerRef.current?.()
      removeTitleResizeListenerRef.current = null

      // Wrapped titles cannot truncate; skip measurements and observers that would only churn unused state.
      if (!node || editingRef.current || wrapTitle) {
        measureTitleTruncated(null)
        return
      }

      measureTitleTruncated(node)
      const updateTitleTruncated = () => measureTitleTruncated(node)
      if (typeof ResizeObserver === 'undefined') {
        window.addEventListener('resize', updateTitleTruncated)
        removeTitleResizeListenerRef.current = () =>
          window.removeEventListener('resize', updateTitleTruncated)
        return
      }

      // Width changes can clip unchanged text; track rendered geometry for the tooltip.
      const observer = new ResizeObserver(updateTitleTruncated)
      observer.observe(node)
      titleResizeObserverRef.current = observer
    },
    [measureTitleTruncated, wrapTitle]
  )

  // Re-key only the display title for measurement; sharing the key would remount/reselect an active editor on unread changes.
  const titleElementKey = `${displayName}:${showUnreadEmphasis ? 'unread' : 'read'}`

  const setEditingMode = useCallback(
    (nextEditing: boolean) => {
      if (editingRef.current === nextEditing) {
        return
      }
      editingRef.current = nextEditing
      if (nextEditing) {
        measureTitleTruncated(null)
      }
      setEditing(nextEditing)
      // Notify synchronously so parents disable drag before the next editing commit.
      onEditingChange?.(nextEditing)
    },
    [measureTitleTruncated, onEditingChange]
  )

  const openRenameEditor = useCallback(() => {
    setEditingMode(true)
  }, [setEditingMode])

  const closeRenameEditor = useCallback(() => {
    setEditingMode(false)
  }, [setEditingMode])

  // Always consume shortcut requests, including disabled/already-editing states, so parent triggers cannot linger.
  useEffect(() => {
    if (!beginEditing) {
      return
    }
    onBeginEditingConsumed?.()
    if (disabled || editing) {
      return
    }
    openRenameEditor()
  }, [beginEditing, disabled, editing, onBeginEditingConsumed, openRenameEditor])

  const startRename = useCallback(
    (event: React.MouseEvent<HTMLElement>) => {
      if (disabled) {
        return
      }
      event.preventDefault()
      event.stopPropagation()
      openRenameEditor()
    },
    [disabled, openRenameEditor]
  )

  if (editing) {
    const editingFallback = (
      <span
        className={cn(
          'relative grid min-w-0 truncate leading-tight text-foreground',
          showUnreadEmphasis ? 'font-semibold' : 'font-normal',
          className,
          editingClassName
        )}
        data-worktree-title-inline-rename="editing"
      >
        <span className="col-start-1 row-start-1 min-w-0 truncate whitespace-pre">
          {displayName}
        </span>
      </span>
    )

    return (
      <Suspense fallback={editingFallback}>
        <WorktreeTitleInlineRenameEditor
          displayName={displayName}
          showUnreadEmphasis={showUnreadEmphasis}
          editingPresentation={editingPresentation}
          className={className}
          editingClassName={editingClassName}
          inputClassName={inputClassName}
          onRename={onRename}
          onClose={closeRenameEditor}
        />
      </Suspense>
    )
  }

  const titleEmphasisClassName = showUnreadEmphasis
    ? 'font-semibold text-foreground'
    : dimReadTitle
      ? 'font-normal text-foreground/80'
      : 'font-normal text-foreground'

  const title = (
    <span
      key={`title:${titleElementKey}`}
      ref={handleRootRef}
      className={cn(
        'block min-w-0 leading-tight focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-worktree-sidebar-ring',
        wrapTitle ? 'break-words whitespace-normal' : 'truncate',
        titleEmphasisClassName,
        className
      )}
      data-worktree-title-inline-rename=""
      onDoubleClick={startRename}
      tabIndex={disabled ? undefined : 0}
    >
      {/* Why: visible text alone misses the unread state for assistive tech. */}
      {showUnreadEmphasis && (
        <span className="sr-only">
          {t('auto.components.sidebar.WorktreeTitleInlineRename.2f42ae024f', 'Unread:')}
        </span>
      )}
      {displayName}
    </span>
  )

  if (titleWrapper) {
    return titleWrapper(title)
  }

  if (wrapTitle || !titleTruncated) {
    return title
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>{title}</TooltipTrigger>
      <TooltipContent side="right" sideOffset={8}>
        {displayName}
      </TooltipContent>
    </Tooltip>
  )
}
