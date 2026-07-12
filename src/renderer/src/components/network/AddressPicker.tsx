import React, { useState } from 'react'
import { Plus } from 'lucide-react'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue
} from '../ui/select'
import {
  CustomAddressDialog,
  type CustomAddressDialogCopy,
  type CustomAddressValidator
} from './CustomAddressDialog'

export type AddressOption = {
  value: string
  label: string
}

// Why: a sentinel Select value for the footer action. It is never committed as
// a real address; selecting it opens the custom-address dialog instead.
const ADD_CUSTOM_VALUE = '__add_custom_address__'

export type AddressPickerProps = {
  options: readonly AddressOption[]
  value: string | undefined
  onValueChange: (value: string) => void
  // Why: a value that isn't one of `options` is a custom entry; this renders
  // its display label (e.g. `${value} (custom)`) so the Select can show it —
  // Radix Select only displays values that have a matching item.
  formatCustomLabel: (value: string) => string
  addCustomLabel: string
  customDialogCopy: CustomAddressDialogCopy
  validateCustom: CustomAddressValidator
  customInputId: string
  placeholder: string
  triggerAriaLabel: string
  disabled?: boolean
  className?: string
  id?: string
}

export function AddressPicker({
  options,
  value,
  onValueChange,
  formatCustomLabel,
  addCustomLabel,
  customDialogCopy,
  validateCustom,
  customInputId,
  placeholder,
  triggerAriaLabel,
  disabled = false,
  className,
  id
}: AddressPickerProps): React.JSX.Element {
  const [dialogOpen, setDialogOpen] = useState(false)

  const isCustomSelection =
    value !== undefined && value !== '' && !options.some((option) => option.value === value)

  const handleValueChange = (next: string): void => {
    if (next === ADD_CUSTOM_VALUE) {
      setDialogOpen(true)
      return
    }
    onValueChange(next)
  }

  return (
    <>
      <Select value={value ?? ''} onValueChange={handleValueChange} disabled={disabled}>
        <SelectTrigger id={id} size="sm" className={className} aria-label={triggerAriaLabel}>
          <SelectValue placeholder={placeholder} />
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
          {isCustomSelection ? (
            <SelectItem value={value}>{formatCustomLabel(value)}</SelectItem>
          ) : null}
          {options.length > 0 || isCustomSelection ? <SelectSeparator /> : null}
          <SelectItem
            value={ADD_CUSTOM_VALUE}
            className="text-muted-foreground focus:text-foreground"
          >
            <Plus className="size-3.5" />
            {addCustomLabel}
          </SelectItem>
        </SelectContent>
      </Select>
      <CustomAddressDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        initialValue={isCustomSelection ? value : undefined}
        validate={validateCustom}
        copy={customDialogCopy}
        inputId={customInputId}
        onConfirm={onValueChange}
      />
    </>
  )
}
