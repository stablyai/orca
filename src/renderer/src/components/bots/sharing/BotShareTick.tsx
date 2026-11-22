import { Checkbox } from '@/components/ui/checkbox'

/** A part's tick; without onChange it shows a part that never goes out. */
export function Tick({
  checked,
  label,
  onChange
}: {
  checked: boolean
  label: string
  onChange?: (on: boolean) => void
}): React.JSX.Element {
  return (
    <Checkbox
      checked={checked}
      disabled={!onChange}
      aria-label={label}
      onCheckedChange={(value) => onChange?.(value === true)}
    />
  )
}
