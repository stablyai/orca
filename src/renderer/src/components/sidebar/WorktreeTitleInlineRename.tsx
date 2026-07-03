import React, { useCallback, useEffect, useRef, useState } from 'react'
import { LoaderCircle } from 'lucide-react'
import { toast } from 'sonner'
import { Input } from '@/components/ui/input'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { isImeCompositionKeyDown } from '@/lib/ime-composition-keyboard-event'
import { translate } from '@/i18n/i18n'

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
  className?: string
  editingClassName?: string
  inputClassName?: string
  titleWrapper?: (title: React.ReactElement) => React.ReactElement
  onEditingChange?: (editing: boolean) => void
  onRename: (displayName: string) => Promise<void> | void
  // Why: lets a parent (e.g. the workspace.rename shortcut via WorktreeCard)
  // open the editor imperatively. The parent clears its trigger in
  // onBeginEditingConsumed so the request fires exactly once.
  beginEditing?: boolean
  onBeginEditingConsumed?: () => void
}

export function WorktreeTitleInlineRename({
  displayName,
  disabled = false,
  showUnreadEmphasis = false,
  dimReadTitle = false,
  className,
  editingClassName,
  inputClassName,
  titleWrapper,
  onEditingChange,
  onRename,
  beginEditing = false,
  onBeginEditingConsumed
}: WorktreeTitleInlineRenameProps): React.JSX.Element {
  const editingRef = useRef(false)
  const savingRef = useRef(false)
  const mountedRef = useRef(true)
  const titleElementRef = useRef<HTMLSpanElement | null>(null)
  const titleResizeObserverRef = useRef<ResizeObserver | null>(null)
  const removeTitleResizeListenerRef = useRef<(() => void) | null>(null)
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState(displayName)
  const [saving, setSaving] = useState(false)
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

      // Why: rename can resolve after this inline title unmounts; the rendered
      // root owns that stale-write guard without a mount-only Effect.
      mountedRef.current = node !== null
      titleElementRef.current = node
      if (!node || editingRef.current) {
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

      // Why: compact sidebar width changes can make a readable title become
      // clipped; the tooltip should track the rendered geometry, not just text.
      const observer = new ResizeObserver(updateTitleTruncated)
      observer.observe(node)
      titleResizeObserverRef.current = observer
    },
    [measureTitleTruncated]
  )

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
      // Why: the parent card disables drag while renaming; an Effect leaves one draggable commit.
      onEditingChange?.(nextEditing)
    },
    [measureTitleTruncated, onEditingChange]
  )

  const handleInputRef = useCallback((input: HTMLInputElement | null) => {
    if (!input) {
      return
    }
    input.focus()
    // Why: double-click rename should make replacing the workspace title a one-keystroke action.
    input.select()
  }, [])

  // Why: open the editor when a parent requests it (the workspace.rename
  // shortcut). Always consume the request so the parent's trigger can't linger;
  // skip the actual open when disabled or already editing.
  useEffect(() => {
    if (!beginEditing) {
      return
    }
    onBeginEditingConsumed?.()
    if (disabled || editing) {
      return
    }
    setValue(displayName)
    setEditing(true)
  }, [beginEditing, disabled, editing, displayName, onBeginEditingConsumed])

  const stopCardEvent = useCallback((event: React.SyntheticEvent) => {
    event.stopPropagation()
  }, [])

  const startRename = useCallback(
    (event: React.MouseEvent<HTMLElement>) => {
      if (disabled) {
        return
      }
      event.preventDefault()
      event.stopPropagation()
      setValue(displayName)
      setEditingMode(true)
    },
    [disabled, displayName, setEditingMode]
  )

  const cancelRename = useCallback(() => {
    setValue(displayName)
    setEditingMode(false)
  }, [displayName, setEditingMode])

  const commitRename = useCallback(async () => {
    if (savingRef.current) {
      return
    }

    const commit = getWorktreeTitleRenameCommit(displayName, value)
    if (commit.kind === 'cancel') {
      cancelRename()
      return
    }

    savingRef.current = true
    setSaving(true)
    try {
      await onRename(commit.displayName)
      if (mountedRef.current) {
        setEditingMode(false)
      }
    } catch (err) {
      if (mountedRef.current) {
        toast.error(
          err instanceof Error
            ? err.message
            : translate(
                'auto.components.sidebar.WorktreeTitleInlineRename.8df295a78d',
                'Failed to rename workspace.'
              )
        )
      }
    } finally {
      savingRef.current = false
      if (mountedRef.current) {
        setSaving(false)
      }
    }
  }, [cancelRename, displayName, onRename, setEditingMode, value])

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>) => {
      event.stopPropagation()
      // Why: an Enter that only confirms a CJK IME candidate must not commit the
      // rename; wait for a non-composition Enter.
      if (isImeCompositionKeyDown(event)) {
        return
      }
      if (event.key === 'Enter') {
        event.preventDefault()
        void commitRename()
      } else if (event.key === 'Escape') {
        event.preventDefault()
        cancelRename()
      }
    },
    [cancelRename, commitRename]
  )

  if (editing) {
    return (
      <span
        key={`editing:${titleElementKey}`}
        ref={handleRootRef}
        className={cn(
          'relative grid min-w-0 truncate leading-tight text-foreground',
          showUnreadEmphasis ? 'font-semibold' : 'font-normal',
          className,
          editingClassName
        )}
        data-worktree-title-inline-rename="editing"
      >
        <span
          className="invisible col-start-1 row-start-1 min-w-0 truncate whitespace-pre"
          aria-hidden="true"
        >
          {displayName}
        </span>
        <Input
          ref={handleInputRef}
          value={value}
          style={{ font: 'inherit' }}
          disabled={saving}
          aria-label={translate(
            'auto.components.sidebar.WorktreeTitleInlineRename.bff3bdd00c',
            'Rename workspace'
          )}
          data-worktree-title-rename-input="true"
          onChange={(event) => setValue(event.target.value)}
          onBlur={() => void commitRename()}
          onClick={stopCardEvent}
          onDoubleClick={stopCardEvent}
          onPointerDown={stopCardEvent}
          onKeyDown={handleKeyDown}
          className={cn(
            'col-start-1 row-start-1 h-[1lh] min-w-0 select-text truncate rounded-none border-0 !border-transparent !bg-transparent p-0 text-foreground !shadow-none outline-none dark:!bg-transparent',
            'focus-visible:border-transparent focus-visible:ring-0 focus-visible:outline-none',
            saving && 'pr-4',
            inputClassName
          )}
        />
        {saving ? (
          <LoaderCircle className="pointer-events-none absolute right-0 top-1/2 size-3 -translate-y-1/2 animate-spin text-muted-foreground" />
        ) : null}
      </span>
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
        'block min-w-0 truncate leading-tight focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-worktree-sidebar-ring',
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
          {translate('auto.components.sidebar.WorktreeTitleInlineRename.2f42ae024f', 'Unread:')}
        </span>
      )}
      {displayName}
    </span>
  )

  if (titleWrapper) {
    return titleWrapper(title)
  }

  if (!titleTruncated) {
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
