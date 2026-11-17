import React, { useId, useRef, useState } from 'react'
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
import { cn } from '@/lib/class-names'
import { useTranslate } from '@/i18n/use-translate'
import { REPO_COLORS } from '../../../../../shared/repository/appearance/repo-badge-color'
import {
  MAX_WORKSPACE_LABEL_NAME_LENGTH,
  validateWorkspaceLabelName,
  type WorkspaceLabel
} from '../../../../../shared/workspace/labels/workspace-labels'

// Mounted only while open, so each open starts from an empty draft.
export function NewWorkspaceLabelDialog({
  existing,
  onOpenChange,
  onSubmit
}: {
  existing: readonly WorkspaceLabel[]
  onOpenChange: (open: boolean) => void
  // If the name gets taken meanwhile, `existing` updates and the dialog shows the error.
  onSubmit: (name: string, color: string) => void
}): React.JSX.Element {
  const t = useTranslate()
  const inputId = useId()
  const inputRef = useRef<HTMLInputElement>(null)
  const [name, setName] = useState('')
  const [color, setColor] = useState<string>(REPO_COLORS[4])
  const [touched, setTouched] = useState(false)
  const nameError = validateWorkspaceLabelName(name, existing)
  const errorText =
    nameError === 'taken'
      ? t('workspaceLabels.dialog.nameTaken', 'A label with this name already exists.')
      : nameError === 'too-long'
        ? t('workspaceLabels.dialog.nameTooLong', 'Use {{max}} characters or fewer.', {
            max: MAX_WORKSPACE_LABEL_NAME_LENGTH
          })
        : null

  const handleSubmit = (event: React.FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    setTouched(true)
    if (nameError === null) {
      onSubmit(name, color)
    }
  }

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent
        className="max-w-sm sm:max-w-sm"
        onOpenAutoFocus={(event) => {
          event.preventDefault()
          inputRef.current?.focus()
        }}
      >
        <DialogHeader>
          <DialogTitle>{t('workspaceLabels.dialog.title', 'New Label')}</DialogTitle>
          <DialogDescription>
            {t(
              'workspaceLabels.dialog.description',
              'Create a label and add it to this workspace.'
            )}
          </DialogDescription>
        </DialogHeader>
        <form className="space-y-4" onSubmit={handleSubmit}>
          <div className="space-y-1">
            <Label htmlFor={inputId}>{t('workspaceLabels.dialog.name', 'Name')}</Label>
            <Input
              id={inputId}
              ref={inputRef}
              value={name}
              onChange={(event) => {
                setName(event.target.value)
                setTouched(true)
              }}
              aria-invalid={touched && errorText !== null}
            />
            {touched && errorText ? <p className="text-xs text-destructive">{errorText}</p> : null}
          </div>
          <div className="space-y-1">
            <Label>{t('workspaceLabels.dialog.color', 'Color')}</Label>
            <div className="flex flex-wrap items-center gap-2">
              {REPO_COLORS.map((swatch) => (
                <button
                  key={swatch}
                  type="button"
                  onClick={() => setColor(swatch)}
                  aria-label={t('workspaceLabels.dialog.useColor', 'Use {{value0}} label color', {
                    value0: swatch
                  })}
                  aria-pressed={color === swatch}
                  className={cn(
                    'size-6 rounded-[4px] outline-none transition-all focus-visible:ring-[3px] focus-visible:ring-ring/50',
                    color === swatch
                      ? 'ring-2 ring-foreground ring-offset-2 ring-offset-background'
                      : 'hover:ring-1 hover:ring-muted-foreground hover:ring-offset-2 hover:ring-offset-background'
                  )}
                  style={{ backgroundColor: swatch }}
                />
              ))}
            </div>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" size="sm" onClick={() => onOpenChange(false)}>
              {t('workspaceLabels.dialog.cancel', 'Cancel')}
            </Button>
            <Button type="submit" size="sm" disabled={nameError !== null}>
              {t('workspaceLabels.dialog.create', 'Create')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
