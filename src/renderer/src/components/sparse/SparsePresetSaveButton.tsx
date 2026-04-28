import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { BookmarkPlus, LoaderCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useAppStore } from '@/store'
import { cn } from '@/lib/utils'
import type { SparsePreset } from '../../../../shared/types'

type SparsePresetSaveButtonProps = {
  repoId: string
  presets: SparsePreset[]
  directories: string[]
  /** When true, the button is enabled. The parent decides eligibility (valid
   *  textarea + sparse mode on) so this component stays purely about
   *  capturing a name and committing the save. */
  enabled: boolean
  /** Called with the saved preset so the parent can highlight it in the
   *  picker and skip showing "edited" state. */
  onSaved: (preset: SparsePreset) => void
}

/** "Save current as preset" — modeled after Chrome's bookmark popover and
 *  Linear's "Save view": a small standalone affordance with its own anchored
 *  popover. Keeps the picker focused on selection and pushes the naming flow
 *  out into a control that visibly *does* one thing. */
export default function SparsePresetSaveButton({
  repoId,
  presets,
  directories,
  enabled,
  onSaved
}: SparsePresetSaveButtonProps): React.JSX.Element {
  const saveSparsePreset = useAppStore((s) => s.saveSparsePreset)

  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  // Why: clear the name on close so re-opening always starts fresh — without
  // this, a cancelled save would silently leak a stale draft into the next
  // open of the popover.
  useEffect(() => {
    if (!open) {
      setName('')
    } else {
      requestAnimationFrame(() => {
        inputRef.current?.focus()
      })
    }
  }, [open])

  const trimmed = name.trim()
  const colliding = useMemo(() => {
    if (!trimmed) {
      return null
    }
    const lower = trimmed.toLowerCase()
    return presets.find((preset) => preset.name.toLowerCase() === lower) ?? null
  }, [presets, trimmed])

  const canSubmit = trimmed.length > 0 && trimmed.length <= 80 && !colliding && !submitting

  const handleSubmit = useCallback(async () => {
    if (!canSubmit) {
      return
    }
    setSubmitting(true)
    try {
      const saved = await saveSparsePreset({ repoId, name: trimmed, directories })
      if (saved) {
        onSaved(saved)
        setOpen(false)
      }
    } finally {
      setSubmitting(false)
    }
  }, [canSubmit, directories, onSaved, repoId, saveSparsePreset, trimmed])

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <Button
              type="button"
              variant="outline"
              size="icon-xs"
              disabled={!enabled}
              aria-label="Save as preset"
              className={cn('size-8 shrink-0', !enabled && 'cursor-not-allowed')}
            >
              <BookmarkPlus className="size-3.5" />
            </Button>
          </PopoverTrigger>
        </TooltipTrigger>
        {/* Why: tooltip is suppressed while the popover is open — they
            visually compete for the same screen space. */}
        {!open ? (
          <TooltipContent side="top" sideOffset={6}>
            Save as preset
          </TooltipContent>
        ) : null}
      </Tooltip>
      <PopoverContent align="end" sideOffset={6} className="w-64 p-3">
        <form
          onSubmit={(event) => {
            event.preventDefault()
            void handleSubmit()
          }}
          className="space-y-2"
        >
          <div className="space-y-1">
            <label
              htmlFor="sparse-preset-save-name"
              className="text-[11px] font-medium text-muted-foreground"
            >
              Save sparse preset
            </label>
            <Input
              id="sparse-preset-save-name"
              ref={inputRef}
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="e.g. web-only"
              maxLength={80}
              autoComplete="off"
              spellCheck={false}
              className="h-8 text-xs"
            />
          </div>
          {colliding ? (
            <p className="text-[10px] text-destructive">
              {`“${colliding.name}” already exists. Pick a different name, or right-click the existing preset to replace it.`}
            </p>
          ) : (
            <p className="text-[10px] text-muted-foreground">
              {directories.length === 1
                ? '1 directory will be saved.'
                : `${directories.length} directories will be saved.`}
            </p>
          )}
          <div className="flex justify-end gap-1">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-xs"
              onClick={() => setOpen(false)}
              disabled={submitting}
            >
              Cancel
            </Button>
            <Button type="submit" size="sm" className="h-7 px-2 text-xs" disabled={!canSubmit}>
              {submitting ? <LoaderCircle className="size-3 animate-spin" /> : null}
              Save
            </Button>
          </div>
        </form>
      </PopoverContent>
    </Popover>
  )
}
