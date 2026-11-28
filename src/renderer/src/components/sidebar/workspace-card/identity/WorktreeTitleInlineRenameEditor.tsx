import React, { useCallback, useRef, useState } from 'react'
import { LoaderCircle } from 'lucide-react'
import { toast } from 'sonner'
import { Input } from '@/components/ui/input'
import { WorkspaceEmojiSuggestionPopover } from '@/components/workspace-emoji/WorkspaceEmojiSuggestionPopover'
import { useWorkspaceEmojiShortcodeInput } from '@/components/workspace-emoji/useWorkspaceEmojiShortcodeInput'
import { cn } from '@/lib/class-names'
import { isImeCompositionKeyDown } from '@/lib/text-input/ime/ime-composition-keyboard-event'
import { useBlurSaveOnUnmount } from '@/lib/text-input/focus/use-blur-save-on-unmount'
import { translate } from '@/i18n/i18n'
import { useTranslate } from '@/i18n/use-translate'
import { getWorktreeTitleRenameCommit } from './WorktreeTitleInlineRename'

export type WorktreeTitleInlineRenameEditorProps = {
  displayName: string
  showUnreadEmphasis: boolean
  editingPresentation: 'text' | 'field'
  className?: string
  editingClassName?: string
  inputClassName?: string
  onRename: (displayName: string) => Promise<void> | void
  onClose: () => void
}

export function WorktreeTitleInlineRenameEditor({
  displayName,
  showUnreadEmphasis,
  editingPresentation,
  className,
  editingClassName,
  inputClassName,
  onRename,
  onClose
}: WorktreeTitleInlineRenameEditorProps): React.JSX.Element {
  const t = useTranslate()
  const activeRef = useRef(true)
  const savingRef = useRef(false)
  const mountedRef = useRef(true)
  const inputElementRef = useRef<HTMLInputElement | null>(null)
  const [value, setValue] = useState(displayName)
  const [saving, setSaving] = useState(false)
  const emojiInput = useWorkspaceEmojiShortcodeInput({
    disabled: saving,
    inputRef: inputElementRef,
    onValueChange: setValue,
    value
  })

  // Inline rows need text-only editing to avoid layout shifts; hovercards can afford the field style.
  const editingInputClassName =
    editingPresentation === 'field'
      ? 'h-6 rounded-sm border border-input bg-input/40 px-1.5 py-0 shadow-xs selection:bg-[Highlight] selection:text-[HighlightText] focus-visible:border-ring focus-visible:ring-[1px] focus-visible:ring-ring/50 dark:bg-input/30'
      : 'h-[1lh] rounded-none border-0 !border-transparent !bg-transparent p-0 !shadow-none focus-visible:border-transparent focus-visible:ring-0 focus-visible:outline-none dark:!bg-transparent'
  const savingInputClassName = editingPresentation === 'field' ? 'pr-6' : 'pr-4'
  const savingSpinnerClassName = editingPresentation === 'field' ? 'right-1.5' : 'right-0'

  const handleRootRef = useCallback((node: HTMLSpanElement | null): void => {
    mountedRef.current = node !== null
  }, [])

  const handleInputRef = useCallback((input: HTMLInputElement | null) => {
    inputElementRef.current = input
    if (!input) {
      return
    }
    input.focus()
    input.select()
  }, [])

  const stopCardEvent = useCallback((event: React.SyntheticEvent) => {
    event.stopPropagation()
  }, [])

  const cancelRename = useCallback(() => {
    activeRef.current = false
    emojiInput.close()
    setValue(displayName)
    onClose()
  }, [displayName, emojiInput, onClose])

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
      activeRef.current = false
      if (mountedRef.current) {
        onClose()
      }
    } catch (err) {
      // Toast even when unmounted: a save from useBlurSaveOnUnmount has no field left to show the old name.
      toast.error(
        err instanceof Error
          ? err.message
          : translate(
              'auto.components.sidebar.WorktreeTitleInlineRename.8df295a78d',
              'Failed to rename workspace.'
            )
      )
    }
    savingRef.current = false
    if (mountedRef.current) {
      setSaving(false)
    }
  }, [cancelRename, displayName, onClose, onRename, value])
  useBlurSaveOnUnmount(() => activeRef.current, commitRename)

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>) => {
      event.stopPropagation()
      if (emojiInput.handleKeyDown(event)) {
        return
      }
      // Composition Enter confirms an IME candidate; rename requires a later non-composition Enter.
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
    [cancelRename, commitRename, emojiInput]
  )

  return (
    <>
      <span
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
          spellCheck={false}
          aria-label={t(
            'auto.components.sidebar.WorktreeTitleInlineRename.bff3bdd00c',
            'Rename workspace'
          )}
          data-worktree-title-rename-input="true"
          onChange={(event) =>
            emojiInput.handleValueChange(event.target.value, event.target.selectionStart)
          }
          onSelect={(event) => emojiInput.syncCursor(event.currentTarget)}
          onBlur={() => void commitRename()}
          onClick={stopCardEvent}
          onDoubleClick={stopCardEvent}
          onPointerDown={stopCardEvent}
          onKeyDown={handleKeyDown}
          className={cn(
            'col-start-1 row-start-1 min-w-0 select-text truncate text-foreground outline-none',
            editingInputClassName,
            saving && savingInputClassName,
            inputClassName
          )}
        />
        {saving ? (
          <LoaderCircle
            className={cn(
              'pointer-events-none absolute top-1/2 size-3 -translate-y-1/2 animate-spin text-muted-foreground',
              savingSpinnerClassName
            )}
          />
        ) : null}
      </span>
      <WorkspaceEmojiSuggestionPopover
        anchorRef={inputElementRef}
        open={emojiInput.open}
        commandValue={emojiInput.commandValue}
        heading={t('auto.components.new.workspace.SmartWorkspaceNameField.emoji', 'Emoji')}
        suggestions={emojiInput.suggestions}
        onCommandValueChange={emojiInput.onCommandValueChange}
        onSelect={emojiInput.selectSuggestion}
        onOpenChange={(open) => !open && emojiInput.close()}
        side="right"
        contentClassName="w-56"
      />
    </>
  )
}
