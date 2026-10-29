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
    ? translate('sessionSearch.panel.resultCount_one', '{{count}} result', {
        count
      })
    : translate('sessionSearch.panel.resultCount_other', '{{count}} results', {
        count
      })
}

/** Left-hand label while browsing: the count, and how much of the scan filters hid. */
export function aiVaultSessionCountLabel(shown: number, loaded: number): string {
  if (shown !== loaded) {
    return loaded === 1
      ? translate(
          'sessionSearch.panel.sessionsShownOfLoaded_one',
          '{{shown}} of {{count}} session',
          {
            shown,
            count: loaded
          }
        )
      : translate(
          'sessionSearch.panel.sessionsShownOfLoaded_other',
          '{{shown}} of {{count}} sessions',
          {
            shown,
            count: loaded
          }
        )
  }
  return shown === 1
    ? translate('sessionSearch.panel.sessionCount_one', '{{count}} session', {
        count: shown
      })
    : translate('sessionSearch.panel.sessionCount_other', '{{count}} sessions', { count: shown })
}

/** Report the visible count and current sort together, with one sort control. */
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
