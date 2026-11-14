import { useRef, useState } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { Button } from '../../ui/button'
import { Select, SelectContent, SelectItem } from '../../ui/select'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger
} from '../../ui/dropdown-menu'
import {
  SourceControlActionOptionField,
  SourceControlActionOptionTrigger
} from './AgentChoiceOptionField'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import { useLegacyModelsExpanded } from '../use-legacy-models-expanded'

const LEGACY_TOGGLE = '__legacy__'

type AgentChoice = { value: string; label: string; legacy?: boolean }

export function AgentChoiceMenu({
  label,
  hint,
  value,
  choices,
  disabled,
  row,
  onChange,
  onOpenChange
}: {
  label: string
  hint?: string | null
  value: string
  /** Legacy choices fold under one row that expands them in place. */
  choices: readonly AgentChoice[]
  disabled?: boolean
  row: boolean
  onChange: (value: string) => void
  onOpenChange?: (open: boolean) => void
}): React.JSX.Element {
  const t = useTranslate()
  const [legacyExpanded, toggleLegacy, resetLegacy] = useLegacyModelsExpanded(
    choices.some((choice) => choice.value === value && choice.legacy)
  )
  const [selectOpen, setSelectOpen] = useState(false)
  // Radix Select closes after every pick; picking the legacy row keeps it open.
  const toggledLegacy = useRef(false)
  const current = choices.find((choice) => choice.value === value)?.label ?? value
  const folded = (choice: AgentChoice) => Boolean(choice.legacy)
  const mainChoices = choices.filter((choice) => !folded(choice))
  const legacyChoices = choices.filter(folded)
  const shownLegacy = legacyExpanded ? legacyChoices : []
  const toggleBody = (
    <>
      <span className="min-w-0 truncate py-0.5">
        {t('agentPicker.moreModelsWithCount', 'More models ({{total}})', {
          total: legacyChoices.length
        })}
      </span>
      <ChevronRight
        className={cn(
          'ml-auto size-3.5 shrink-0 text-muted-foreground transition-transform',
          legacyExpanded && 'rotate-90'
        )}
      />
    </>
  )
  if (row) {
    const radioItem = (choice: AgentChoice) => (
      <DropdownMenuRadioItem
        key={choice.value}
        value={choice.value}
        disabled={disabled}
        onSelect={() => onChange(choice.value)}
      >
        <span className="min-w-0 truncate py-0.5">{choice.label}</span>
      </DropdownMenuRadioItem>
    )
    return (
      <div className="flex min-h-7 min-w-0 items-center justify-between gap-3">
        <span className="text-xs text-muted-foreground">{label}</span>
        <DropdownMenu
          onOpenChange={(open) => {
            if (open) {
              resetLegacy()
            }
            onOpenChange?.(open)
          }}
        >
          <DropdownMenuTrigger asChild disabled={disabled}>
            <Button
              type="button"
              variant="outline"
              size="xs"
              aria-label={`${label}: ${current}`}
              className="min-w-0 max-w-full"
            >
              <span className="truncate text-xs">{current}</span>
              <ChevronDown className="size-3 shrink-0" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" collisionPadding={8} className="w-80">
            <DropdownMenuRadioGroup value={value}>
              {mainChoices.map(radioItem)}
              {shownLegacy.map(radioItem)}
              {legacyChoices.length > 0 ? (
                <DropdownMenuItem
                  inset
                  aria-expanded={legacyExpanded}
                  onSelect={(event) => {
                    event.preventDefault()
                    toggleLegacy()
                  }}
                >
                  {toggleBody}
                </DropdownMenuItem>
              ) : null}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    )
  }
  const selectItem = (choice: AgentChoice) => (
    <SelectItem key={choice.value} value={choice.value}>
      {choice.label}
    </SelectItem>
  )
  return (
    <SourceControlActionOptionField label={label} hint={hint}>
      <Select
        value={value}
        disabled={disabled}
        open={selectOpen}
        onValueChange={(next) => {
          if (next === LEGACY_TOGGLE) {
            // Typeahead on the closed trigger selects without a close to swallow.
            toggledLegacy.current = selectOpen
            toggleLegacy()
            return
          }
          onChange(next)
        }}
        onOpenChange={(open) => {
          if (!open && toggledLegacy.current) {
            toggledLegacy.current = false
            return
          }
          if (open) {
            resetLegacy()
          }
          setSelectOpen(open)
          onOpenChange?.(open)
        }}
      >
        <SourceControlActionOptionTrigger label={current} disabled={disabled} />
        <SelectContent>
          {mainChoices.map(selectItem)}
          {shownLegacy.map(selectItem)}
          {legacyChoices.length > 0 ? (
            <SelectItem value={LEGACY_TOGGLE} aria-expanded={legacyExpanded}>
              <span className="flex w-full min-w-0 items-center gap-2">{toggleBody}</span>
            </SelectItem>
          ) : null}
        </SelectContent>
      </Select>
    </SourceControlActionOptionField>
  )
}
