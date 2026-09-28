import type React from 'react'
import { ChevronDown } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { translate } from '@/i18n/i18n'
import type { AiVaultSortMenu } from './ai-vault-sort-options'

/** Left-hand label while searching: how many hits the list is showing. */
export function aiVaultResultCountLabel(count: number): string {
  return count === 1
    ? translate('sessionSearch.panel.resultsOne', '{{count}} result', { count })
    : translate('sessionSearch.panel.resultsOther', '{{count}} results', { count })
}

/**
 * Left-hand label while browsing: the count, and how much of the scan filters hid.
 * `atLimit` marks a total that is only the scan's cap, not every session on disk.
 */
export function aiVaultSessionCountLabel(shown: number, loaded: number, atLimit = false): string {
  if (atLimit) {
    return shown !== loaded
      ? translate(
          'sessionSearch.panel.sessionsOfLoadedAtLimit',
          '{{value0}} of {{value1}}+ sessions',
          {
            value0: shown,
            value1: loaded
          }
        )
      : // No singular form on purpose: "+" makes the number a lower bound, so
        // "1+ sessions" is the reading even when exactly one row is shown.
        translate('sessionSearch.panel.sessionsAtLimit', '{{count}}+ sessions', { count: shown })
  }
  if (shown !== loaded) {
    return translate('sessionSearch.panel.sessionsOfLoaded', '{{value0}} of {{value1}} sessions', {
      value0: shown,
      value1: loaded
    })
  }
  return shown === 1
    ? translate('sessionSearch.panel.sessionsOne', '{{count}} session', { count: shown })
    : translate('sessionSearch.panel.sessionsOther', '{{count}} sessions', { count: shown })
}

/**
 * The bar above the session list: what the list is showing on the left, the order that
 * produced it on the right — the one place sort is both reported and changed.
 */
export function AiVaultSessionListBar<Value extends string>({
  label,
  value,
  menu,
  onChange
}: {
  label: string
  value: Value
  menu: AiVaultSortMenu<Value>
  onChange: (value: Value) => void
}): React.JSX.Element {
  const selected = menu.options.find((option) => option.value === value)
  return (
    <div className="flex h-8 shrink-0 items-center gap-2 border-y border-sidebar-border bg-sidebar-accent/60 pl-3 pr-1.5">
      <span className="min-w-0 flex-1 truncate text-xs font-semibold tabular-nums text-foreground">
        {label}
      </span>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="xs"
            className="shrink-0"
            aria-label={menu.ariaLabel(selected?.label ?? '')}
          >
            {selected?.label}
            <ChevronDown className="text-muted-foreground" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-0">
          <DropdownMenuRadioGroup
            value={value}
            // Radix hands back a bare string; the option list is what narrows it.
            onValueChange={(next) => {
              const picked = menu.options.find((option) => option.value === next)
              if (picked) {
                onChange(picked.value)
              }
            }}
          >
            {menu.options.map((option) => (
              <DropdownMenuRadioItem key={option.value} value={option.value}>
                {option.label}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}
