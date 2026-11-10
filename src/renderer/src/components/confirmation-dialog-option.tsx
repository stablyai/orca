import React from 'react'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import type { ConfirmationDialogOptions } from '@/components/confirmation-dialog-context'

/** A confirmation's optional part: sits in the body, right under the description, because it
 *  changes what the confirm button does. The line under it says what the current state means. */
export function ConfirmationDialogOption({
  option,
  checked,
  onCheckedChange
}: {
  option: NonNullable<ConfirmationDialogOptions['option']>
  checked: boolean
  onCheckedChange: (checked: boolean) => void
}): React.JSX.Element {
  const detail =
    checked || option.uncheckedDetail === undefined ? option.detail : option.uncheckedDetail
  return (
    <div
      className="group flex items-start gap-2 data-[disabled=true]:cursor-not-allowed"
      data-disabled={option.disabled === true}
    >
      <Checkbox
        id="confirmation-dialog-option"
        className="mt-0.5"
        checked={checked}
        disabled={option.disabled}
        onCheckedChange={(value) => onCheckedChange(value === true)}
        aria-describedby={detail ? 'confirmation-dialog-option-detail' : undefined}
      />
      <div className="space-y-1">
        <Label htmlFor="confirmation-dialog-option">{option.label}</Label>
        {detail ? (
          <p
            id="confirmation-dialog-option-detail"
            className="text-xs text-muted-foreground"
            aria-live="polite"
          >
            {detail}
          </p>
        ) : null}
      </div>
    </div>
  )
}
