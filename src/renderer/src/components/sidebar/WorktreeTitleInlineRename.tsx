import React, { useCallback, useRef, useState } from 'react'
import { LoaderCircle } from 'lucide-react'
import { toast } from 'sonner'
import { Input } from '@/components/ui/input'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

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

type WorktreeTitleInlineRenameProps = {
  displayName: string
  disabled?: boolean
  showUnreadEmphasis?: boolean
  className?: string
  editingClassName?: string
  inputClassName?: string
  onEditingChange?: (editing: boolean) => void
  onRename: (displayName: string) => Promise<void> | void
}

export function WorktreeTitleInlineRename({
  displayName,
  disabled = false,
  showUnreadEmphasis = false,
  className,
  editingClassName,
  inputClassName,
  onEditingChange,
  onRename
}: WorktreeTitleInlineRenameProps): React.JSX.Element {
  const editingRef = useRef(false)
  const savingRef = useRef(false)
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState(displayName)
  const [saving, setSaving] = useState(false)

  const setEditingMode = useCallback(
    (nextEditing: boolean) => {
      if (editingRef.current === nextEditing) {
        return
      }
      editingRef.current = nextEditing
      setEditing(nextEditing)
      // Why: the parent card disables drag while renaming; an Effect leaves one draggable commit.
      onEditingChange?.(nextEditing)
    },
    [onEditingChange]
  )

  const handleInputRef = useCallback((input: HTMLInputElement | null) => {
    if (!input) {
      return
    }
    input.focus()
    // Why: double-click rename should make replacing the workspace title a one-keystroke action.
    input.select()
  }, [])

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
      setEditingMode(false)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to rename workspace.')
    } finally {
      savingRef.current = false
      setSaving(false)
    }
  }, [cancelRename, displayName, onRename, setEditingMode, value])

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>) => {
      event.stopPropagation()
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
          aria-label="Rename workspace"
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

  const title = (
    <span
      className={cn(
        'block min-w-0 truncate leading-tight text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-sidebar-ring',
        showUnreadEmphasis ? 'font-semibold' : 'font-normal',
        className
      )}
      data-worktree-title-inline-rename=""
      onDoubleClick={startRename}
      tabIndex={disabled ? undefined : 0}
    >
      {/* Why: visible text alone misses the unread state for assistive tech. */}
      {showUnreadEmphasis && <span className="sr-only">Unread: </span>}
      {displayName}
    </span>
  )

  return (
    <Tooltip>
      <TooltipTrigger asChild>{title}</TooltipTrigger>
      <TooltipContent side="right" sideOffset={8}>
        {displayName}
      </TooltipContent>
    </Tooltip>
  )
}
