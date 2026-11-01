import { translate } from '@/i18n/i18n'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'

// Radix Select forbids an empty-string item value, so "any" needs a sentinel.
const ANY_VALUE = '__any__'

export function GiteaFilterSelect({
  label,
  value,
  options,
  onChange
}: {
  label: string
  value: string
  options: readonly string[]
  onChange: (value: string) => void
}): React.JSX.Element {
  return (
    <Select
      value={value || ANY_VALUE}
      onValueChange={(next) => onChange(next === ANY_VALUE ? '' : next)}
    >
      <SelectTrigger size="sm" aria-label={label} className="h-7 w-32 text-xs">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={ANY_VALUE}>
          {translate('auto.components.TaskPage.giteaFilterAny', 'Any {{filter}}', {
            filter: label
          })}
        </SelectItem>
        {options.map((option) => (
          <SelectItem key={option} value={option}>
            {option}
          </SelectItem>
        ))}
        {value && !options.includes(value) ? <SelectItem value={value}>{value}</SelectItem> : null}
      </SelectContent>
    </Select>
  )
}
