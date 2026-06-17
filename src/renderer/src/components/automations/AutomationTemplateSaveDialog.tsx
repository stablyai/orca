import React from 'react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { translate } from '@/i18n/i18n'

type AutomationTemplateSaveDialogProps = {
  open: boolean
  isEditing: boolean
  initialLabel: string
  initialDescription: string
  onOpenChange: (open: boolean) => void
  onSave: (label: string, description: string) => void
}

export function AutomationTemplateSaveDialog({
  open,
  isEditing,
  initialLabel,
  initialDescription,
  onOpenChange,
  onSave
}: AutomationTemplateSaveDialogProps): React.JSX.Element {
  const [label, setLabel] = React.useState(initialLabel)
  const [description, setDescription] = React.useState(initialDescription)

  // Why: reseed the local fields each time the dialog opens so it reflects the
  // template being edited (or a blank create) rather than stale prior input.
  React.useEffect(() => {
    if (open) {
      setLabel(initialLabel)
      setDescription(initialDescription)
    }
  }, [open, initialLabel, initialDescription])

  const canSave = label.trim().length > 0

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[440px]">
        <DialogHeader>
          <DialogTitle>
            {isEditing
              ? translate(
                  'auto.components.automations.AutomationTemplateSaveDialog.editTitle',
                  'Update template'
                )
              : translate(
                  'auto.components.automations.AutomationTemplateSaveDialog.createTitle',
                  'Save as template'
                )}
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="template-label">
              {translate(
                'auto.components.automations.AutomationTemplateSaveDialog.label',
                'Template name'
              )}
            </Label>
            <Input
              id="template-label"
              value={label}
              onChange={(event) => setLabel(event.target.value)}
              placeholder={translate(
                'auto.components.automations.AutomationTemplateSaveDialog.labelPlaceholder',
                'Nightly deploy check'
              )}
              autoFocus
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="template-description">
              {translate(
                'auto.components.automations.AutomationTemplateSaveDialog.description',
                'Description (optional)'
              )}
            </Label>
            <Input
              id="template-description"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              placeholder={translate(
                'auto.components.automations.AutomationTemplateSaveDialog.descriptionPlaceholder',
                'What this template is for'
              )}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {translate('auto.components.automations.AutomationTemplateSaveDialog.cancel', 'Cancel')}
          </Button>
          <Button
            variant="outline"
            disabled={!canSave}
            onClick={() => onSave(label.trim(), description.trim())}
          >
            {translate('auto.components.automations.AutomationTemplateSaveDialog.save', 'Save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
