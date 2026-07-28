import React, { useRef, useState } from 'react'
import { Plus } from 'lucide-react'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select'
import { Button } from '../ui/button'
import {
  CustomAddressDialog,
  type CustomAddressDialogCopy,
  type CustomAddressValidator
} from './CustomAddressDialog'

export type AddressOption = {
  value: string
  label: string
}

function getUniqueAddressOptions(options: readonly AddressOption[]): AddressOption[] {
  const seenValues = new Set<string>()
  return options.filter((option) => {
    if (seenValues.has(option.value)) {
      return false
    }
    seenValues.add(option.value)
    return true
  })
}

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
  const dialogInitialValueRef = useRef<string | undefined>(undefined)

  const uniqueOptions = getUniqueAddressOptions(options)
  const customOption =
    value !== undefined && value !== '' && !uniqueOptions.some((option) => option.value === value)
      ? { value, label: formatCustomLabel(value) }
      : undefined
  const selectOptions = customOption ? [...uniqueOptions, customOption] : uniqueOptions
  const handleDialogOpenChange = (open: boolean): void => {
    if (open) {
      dialogInitialValueRef.current = customOption?.value
    }
    setDialogOpen(open)
  }

  return (
    <>
      <Select value={value ?? ''} onValueChange={onValueChange} disabled={disabled}>
        <SelectTrigger id={id} size="sm" className={className} aria-label={triggerAriaLabel}>
          <SelectValue placeholder={placeholder} />
        </SelectTrigger>
        <SelectContent>
          {selectOptions.map((option) => (
            <SelectItem key={option.value} value={option.value} textValue={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <CustomAddressDialog
        open={dialogOpen}
        onOpenChange={handleDialogOpenChange}
        trigger={
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={disabled}
            className="max-w-full text-muted-foreground"
          >
            <Plus className="size-3.5" />
            <span className="min-w-0 truncate">{addCustomLabel}</span>
          </Button>
        }
        initialValue={dialogInitialValueRef.current}
        validate={validateCustom}
        copy={customDialogCopy}
        inputId={customInputId}
        onConfirm={onValueChange}
      />
    </>
  )
}
