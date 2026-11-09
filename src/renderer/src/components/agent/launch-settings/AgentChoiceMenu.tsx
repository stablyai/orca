import { ChevronDown } from 'lucide-react'
import { LoadingSpinner } from '../../LoadingSpinner'
import { Button } from '../../ui/button'
import { Select, SelectContent, SelectItem } from '../../ui/select'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger
} from '../../ui/dropdown-menu'
import {
  SourceControlActionOptionField,
  SourceControlActionOptionTrigger
} from './AgentChoiceOptionField'

export function AgentChoiceMenu({
  label,
  hint,
  value,
  choices,
  disabled,
  pendingLabel,
  row,
  onChange,
  onOpenChange
}: {
  label: string
  hint?: string | null
  value: string
  choices: readonly { value: string; label: string }[]
  disabled?: boolean
  pendingLabel?: string
  row: boolean
  onChange: (value: string) => void
  onOpenChange?: (open: boolean) => void
}): React.JSX.Element {
  const current = pendingLabel ?? choices.find((choice) => choice.value === value)?.label ?? value
  const pending = pendingLabel !== undefined
  if (row) {
    return (
      <div className="flex min-h-7 min-w-0 items-center justify-between gap-3">
        <span className="text-xs text-muted-foreground">{label}</span>
        <DropdownMenu onOpenChange={onOpenChange}>
          <DropdownMenuTrigger asChild disabled={disabled}>
            <Button
              type="button"
              variant="outline"
              size="xs"
              aria-label={`${label}: ${current}`}
              aria-busy={pending}
              className="min-w-0 max-w-full"
            >
              <span className="truncate text-xs">{current}</span>
              {pending ? (
                <LoadingSpinner className="size-3 shrink-0" />
              ) : (
                <ChevronDown className="size-3 shrink-0" />
              )}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" collisionPadding={8} className="w-80">
            <DropdownMenuRadioGroup value={value}>
              {choices.map((choice) => (
                <DropdownMenuRadioItem
                  key={choice.value}
                  value={choice.value}
                  disabled={disabled || pending}
                  onSelect={() => onChange(choice.value)}
                >
                  <span className="min-w-0 truncate py-0.5">{choice.label}</span>
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    )
  }
  return (
    <SourceControlActionOptionField label={label} hint={hint}>
      <Select
        value={value}
        disabled={disabled}
        onValueChange={onChange}
        onOpenChange={onOpenChange}
      >
        <SourceControlActionOptionTrigger label={current} disabled={disabled} pending={pending} />
        <SelectContent>
          {choices.map((choice) => (
            <SelectItem key={choice.value} value={choice.value} disabled={pending}>
              {choice.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </SourceControlActionOptionField>
  )
}
