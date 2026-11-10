import React, { useState } from 'react'
import { useTranslate } from '@/i18n/use-translate'
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

const COLLAPSED_ITEMS = 3

/** The paths (or other names) an action touches: three, then the rest on request. */
export function ConfirmationDialogItemList({
  list,
  indented
}: {
  list: NonNullable<ConfirmationDialogOptions['itemList']>
  /** Lines up under an option's label. */
  indented: boolean
}): React.JSX.Element {
  const t = useTranslate()
  const [expanded, setExpanded] = useState(false)
  const shown = expanded ? list.items : list.items.slice(0, COLLAPSED_ITEMS)
  const hidden = list.total - shown.length
  return (
    <div className={indented ? 'space-y-1 pl-6' : 'space-y-1'}>
      <ul aria-label={list.label} className="space-y-0.5 font-mono text-xs text-muted-foreground">
        {shown.map((item) => (
          <li key={item} className="truncate" title={item}>
            {item}
          </li>
        ))}
      </ul>
      {list.total > COLLAPSED_ITEMS ? (
        <button
          type="button"
          className="rounded-sm text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded
            ? t('components.confirmation.itemList.showFewer', 'Show fewer')
            : t('components.confirmation.itemList.showMore', 'Show {{count}} more', {
                count: hidden,
                defaultValue_one: 'Show {{count}} more'
              })}
        </button>
      ) : null}
    </div>
  )
}
