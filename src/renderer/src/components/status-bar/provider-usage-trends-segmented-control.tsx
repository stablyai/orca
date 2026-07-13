import React from 'react'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'

export function ProviderUsageTrendsSegmentedControl<T extends string>({
  options,
  value,
  onChange,
  ariaLabel
}: {
  options: { value: T; label: string }[]
  value: T
  onChange: (next: T) => void
  ariaLabel: string
}): React.JSX.Element {
  return (
    <ToggleGroup
      type="single"
      value={value}
      onValueChange={(next) => {
        // Why: Radix single toggle groups emit '' when the active item is
        // re-clicked; a trends mode/range must always keep one selection.
        if (next) {
          onChange(next as T)
        }
      }}
      aria-label={ariaLabel}
      className="gap-0.5 rounded-md bg-muted p-0.5"
    >
      {options.map((option) => (
        <ToggleGroupItem
          key={option.value}
          value={option.value}
          className="h-auto min-w-0 rounded-[5px] px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground hover:bg-transparent hover:text-foreground data-[state=on]:bg-background data-[state=on]:text-foreground data-[state=on]:shadow-xs"
        >
          {option.label}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  )
}
