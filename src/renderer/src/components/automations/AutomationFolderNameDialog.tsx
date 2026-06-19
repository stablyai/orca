import React, { useCallback, useId, useRef, useState } from 'react'
import { Check } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import {
  AUTOMATION_FOLDER_COLOR_PRESETS,
  resolveAutomationFolderColor
} from './automation-folder-colors'

export type AutomationFolderNameSubmit = {
  name: string
  color: string | null
}

type AutomationFolderNameDialogProps = {
  open: boolean
  title: string
  description: string
  initialName: string
  initialColor: string | null
  confirmLabel: string
  onOpenChange: (open: boolean) => void
  onSubmit: (value: AutomationFolderNameSubmit) => Promise<void> | void
}

export function AutomationFolderNameDialog({
  open,
  title,
  description,
  initialName,
  initialColor,
  confirmLabel,
  onOpenChange,
  onSubmit
}: AutomationFolderNameDialogProps): React.JSX.Element {
  const inputRef = useRef<HTMLInputElement>(null)
  const inputId = useId()
  const [name, setName] = useState(initialName)
  const [color, setColor] = useState<string | null>(initialColor)
  const [submitting, setSubmitting] = useState(false)
  const [previousOpenState, setPreviousOpenState] = useState({ open, initialName, initialColor })
  const mountedRef = useRef(true)
  const trimmedName = name.trim()

  const handleDialogContentRef = useCallback((node: HTMLDivElement | null): void => {
    // Why: save can finish after the dialog closes; the content ref keeps late
    // completions from mutating stale dialog state without an Effect.
    mountedRef.current = node !== null
  }, [])

  // Why: seed the inputs synchronously on open so the field never flashes a
  // stale draft for one frame (matches ProjectGroupNameDialog).
  if (
    open !== previousOpenState.open ||
    initialName !== previousOpenState.initialName ||
    initialColor !== previousOpenState.initialColor
  ) {
    setPreviousOpenState({ open, initialName, initialColor })
    if (open) {
      setName(initialName)
      setColor(initialColor)
      setSubmitting(false)
    }
  }

  const handleSubmit = useCallback(
    async (event?: React.FormEvent<HTMLFormElement>) => {
      event?.preventDefault()
      if (!trimmedName || submitting) {
        return
      }
      setSubmitting(true)
      try {
        await onSubmit({ name: trimmedName, color })
        if (mountedRef.current) {
          onOpenChange(false)
        }
      } catch (error) {
        console.error('Failed to save automation folder:', error)
        if (mountedRef.current) {
          setSubmitting(false)
        }
      }
    },
    [color, onOpenChange, onSubmit, submitting, trimmedName]
  )

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        ref={handleDialogContentRef}
        className="max-w-sm sm:max-w-sm"
        onOpenAutoFocus={(event) => {
          event.preventDefault()
          inputRef.current?.focus()
          inputRef.current?.select()
        }}
      >
        <DialogHeader>
          <DialogTitle className="text-sm">{title}</DialogTitle>
          <DialogDescription className="text-xs">{description}</DialogDescription>
        </DialogHeader>
        <form className="space-y-4" onSubmit={handleSubmit}>
          <div className="space-y-1">
            <Label htmlFor={inputId} className="text-[11px] text-muted-foreground">
              {translate(
                'auto.components.automations.AutomationFolderNameDialog.name',
                'Folder name'
              )}
            </Label>
            <Input
              id={inputId}
              ref={inputRef}
              value={name}
              onChange={(event) => setName(event.target.value)}
              className="h-8 text-xs"
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-[11px] text-muted-foreground">
              {translate('auto.components.automations.AutomationFolderNameDialog.color', 'Color')}
            </Label>
            <div className="flex flex-wrap items-center gap-1.5">
              <button
                type="button"
                onClick={() => setColor(null)}
                aria-pressed={color === null}
                aria-label={translate(
                  'auto.components.automations.AutomationFolderNameDialog.noColor',
                  'No color'
                )}
                className={cn(
                  'flex size-6 items-center justify-center rounded-full border border-border/70 bg-muted/40 text-muted-foreground transition-colors',
                  color === null
                    ? 'ring-2 ring-foreground ring-offset-1 ring-offset-background'
                    : ''
                )}
              >
                {color === null ? <Check className="size-3.5" strokeWidth={3} /> : null}
              </button>
              {AUTOMATION_FOLDER_COLOR_PRESETS.map((preset) => {
                const resolved = resolveAutomationFolderColor(preset)
                const active = color === preset
                return (
                  <button
                    key={preset}
                    type="button"
                    onClick={() => setColor(preset)}
                    aria-pressed={active}
                    aria-label={preset}
                    style={{ backgroundColor: resolved ?? undefined }}
                    className={cn(
                      'flex size-6 items-center justify-center rounded-full border border-border/40 text-white transition-transform',
                      active ? 'ring-2 ring-foreground ring-offset-1 ring-offset-background' : ''
                    )}
                  >
                    {active ? <Check className="size-3.5" strokeWidth={3} /> : null}
                  </button>
                )
              })}
            </div>
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="text-xs"
              onClick={() => onOpenChange(false)}
            >
              {translate('auto.components.automations.AutomationFolderNameDialog.cancel', 'Cancel')}
            </Button>
            <Button
              type="submit"
              size="sm"
              className="text-xs"
              disabled={!trimmedName || submitting}
            >
              {submitting
                ? translate(
                    'auto.components.automations.AutomationFolderNameDialog.saving',
                    'Saving...'
                  )
                : confirmLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
