import React from 'react'
import { Check, LoaderCircle, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

type InlineNameEditorProps = {
  inputRef: React.RefObject<HTMLInputElement | null>
  value: string
  onChange: (value: string) => void
  onCommit: () => void
  onCancel: () => void
  submitting: boolean
  canCommit: boolean
  collidingName: string | undefined
  placeholder?: string
}

/** Inline name input row used by SparsePresetPicker for both Save and Rename.
 *  Lives inside the popover so we never stack a modal on top of a composer
 *  modal — Cmd+J's quick composer is itself a Dialog, and a second Dialog on
 *  top would lose focus context and feel cramped. */
export default function InlineNameEditor({
  inputRef,
  value,
  onChange,
  onCommit,
  onCancel,
  submitting,
  canCommit,
  collidingName,
  placeholder
}: InlineNameEditorProps): React.JSX.Element {
  return (
    <div className="space-y-1 px-2 py-1.5">
      <div className="flex items-center gap-1">
        <Input
          ref={inputRef}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              onCommit()
            } else if (event.key === 'Escape') {
              event.preventDefault()
              onCancel()
            }
          }}
          placeholder={placeholder}
          maxLength={80}
          autoComplete="off"
          spellCheck={false}
          className="h-7 text-xs"
        />
        <Button
          type="button"
          size="icon-xs"
          variant="ghost"
          disabled={!canCommit || submitting}
          onClick={onCommit}
          aria-label="Save"
          className="size-7 shrink-0 text-foreground hover:text-foreground"
        >
          {submitting ? (
            <LoaderCircle className="size-3.5 animate-spin" />
          ) : (
            <Check className="size-3.5" />
          )}
        </Button>
        <Button
          type="button"
          size="icon-xs"
          variant="ghost"
          disabled={submitting}
          onClick={onCancel}
          aria-label="Cancel"
          className="size-7 shrink-0 text-muted-foreground"
        >
          <X className="size-3.5" />
        </Button>
      </div>
      {collidingName ? (
        <p className="px-1 text-[10px] text-destructive">
          {`“${collidingName}” already exists. Pick a different name.`}
        </p>
      ) : null}
    </div>
  )
}
