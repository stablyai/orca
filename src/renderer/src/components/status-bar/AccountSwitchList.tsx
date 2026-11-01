import { Search } from 'lucide-react'
import React, { useState } from 'react'
import {
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { useImeEnterGestureOwnership } from '@/lib/ime-composition-keyboard-event'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import { useResetCountdownClock } from '@/hooks/useResetCountdownClock'
import type { ProviderRateLimits } from '../../../../shared/rate-limit-types'
import type { UsagePercentageDisplay } from '../../../../shared/usage-percentage-display'
import {
  ACCOUNT_SWITCH_LONG_LIST_THRESHOLD,
  filterAccountSwitchEntries,
  getPrevailingWorkspace,
  getSharedEmails,
  groupAccountSwitchEntries,
  type AccountSwitchGroupKind,
  type AccountSwitchSort
} from './account-switch-row-model'
import {
  AccountSwitchRowItem,
  selectAccountSwitchRow,
  type AccountSwitchListRow
} from './AccountSwitchRowItem'
import { getUsageRosterRowState } from './usage-roster-row-state'

export type { AccountSwitchListRow } from './AccountSwitchRowItem'

/** Text for the usage cell when an account reports no usage windows. */
export function getAccountSwitchStatusLabel(limits: ProviderRateLimits | null): string | null {
  if (!limits || limits.status !== 'error') {
    return null
  }
  const state = getUsageRosterRowState(limits, false)
  return state.kind === 'sign-in'
    ? translate('auto.components.status.bar.StatusBar.f19a63e7cd', 'Sign in to see usage')
    : state.statusLabel
}

function groupHeading(kind: AccountSwitchGroupKind): string | null {
  switch (kind) {
    case 'accounts':
      return translate('auto.components.status.bar.AccountSwitchList.accounts', 'Accounts')
    case 'plan-limit':
      return translate(
        'auto.components.status.bar.AccountSwitchList.planLimit',
        'Plan limit reached'
      )
    case 'sign-in':
      return translate(
        'auto.components.status.bar.AccountSwitchList.signInRequired',
        'Sign-in required'
      )
    case 'default':
      return null
  }
}

function SortToggle({
  value,
  onChange
}: {
  value: AccountSwitchSort
  onChange: (value: AccountSwitchSort) => void
}): React.JSX.Element {
  const options: { value: AccountSwitchSort; label: string }[] = [
    {
      value: 'name',
      label: translate('auto.components.status.bar.AccountSwitchList.sortByName', 'A–Z')
    },
    {
      value: 'least-used',
      label: translate('auto.components.status.bar.AccountSwitchList.sortLeastUsed', 'Least used')
    }
  ]
  return (
    <DropdownMenuRadioGroup
      value={value}
      onValueChange={(nextValue) => {
        if (nextValue === 'name' || nextValue === 'least-used') {
          onChange(nextValue)
        }
      }}
      aria-label={translate(
        'auto.components.status.bar.AccountSwitchList.sortLabel',
        'Sort accounts'
      )}
      className="inline-flex rounded-md bg-muted p-0.5"
    >
      {options.map((option) => (
        <DropdownMenuRadioItem
          key={option.value}
          value={option.value}
          onSelect={(event) => event.preventDefault()}
          className={cn(
            'rounded-sm py-0 pr-1.5 pl-5 text-3xs leading-5 text-muted-foreground [&>span]:left-1 [&>span]:size-3',
            value === option.value && 'bg-background text-foreground shadow-xs'
          )}
        >
          {option.label}
        </DropdownMenuRadioItem>
      ))}
    </DropdownMenuRadioGroup>
  )
}

export function AccountSwitchList({
  heading,
  rows,
  display
}: {
  heading: string
  rows: AccountSwitchListRow[]
  display: UsagePercentageDisplay
}): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<AccountSwitchSort>('name')
  const searchIme = useImeEnterGestureOwnership()
  const now = useResetCountdownClock(
    rows.map((row) => (row.usage.kind === 'plan-limit' ? row.usage.resetsAt : null))
  )
  const prevailingWorkspace = getPrevailingWorkspace(rows)
  const sharedEmails = getSharedEmails(rows)
  const accountCount = rows.filter((row) => row.email !== null).length
  const isLong = accountCount > ACCOUNT_SWITCH_LONG_LIST_THRESHOLD
  const usageHeading =
    display === 'used'
      ? translate('auto.components.status.bar.AccountSwitchList.usedHeading', 'Used')
      : translate('auto.components.status.bar.AccountSwitchList.leftHeading', 'Left')

  const renderRow = (row: AccountSwitchListRow): React.JSX.Element => (
    <AccountSwitchRowItem
      key={row.key}
      row={row}
      prevailingWorkspace={prevailingWorkspace}
      sharesEmail={row.email !== null && sharedEmails.has(row.email.toLowerCase())}
      display={display}
      now={now}
    />
  )

  if (!isLong) {
    return (
      <div className="px-1 pb-1">
        <div className="flex items-baseline justify-between px-2.5 pt-1.5 pb-1">
          <span className="text-xs font-medium text-foreground">{heading}</span>
          <span className="text-3xs tracking-wider text-muted-foreground uppercase">
            {usageHeading}
          </span>
        </div>
        {rows.map(renderRow)}
      </div>
    )
  }

  const groups = groupAccountSwitchEntries(filterAccountSwitchEntries(rows, query), sort)
  return (
    <div className="px-1 pb-1">
      <div className="flex items-center justify-between gap-2 px-2.5 pt-1.5 pb-1">
        <span className="text-xs font-medium text-foreground">{heading}</span>
        <SortToggle value={sort} onChange={setSort} />
      </div>
      <label className="mx-1 mb-1 flex items-center gap-1.5 rounded-md bg-muted px-2 text-muted-foreground focus-within:ring-[3px] focus-within:ring-ring/50">
        <Search className="size-3.5 shrink-0" />
        <DropdownMenuItem asChild onSelect={(event) => event.preventDefault()}>
          <Input
            type="text"
            role="textbox"
            value={query}
            spellCheck={false}
            autoComplete="off"
            placeholder={translate(
              'auto.components.status.bar.AccountSwitchList.filterPlaceholder',
              'Filter {{count}} accounts',
              { count: accountCount }
            )}
            aria-label={translate(
              'auto.components.status.bar.AccountSwitchList.filterLabel',
              'Filter accounts'
            )}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDownCapture={(event) => {
              // Capture keeps text editing (including Space) out of Radix's item activation/typeahead.
              if (searchIme.ownsKeyDown(event) || searchIme.isComposing()) {
                event.stopPropagation()
                return
              }
              if (event.key === 'Enter') {
                event.preventDefault()
                event.stopPropagation()
                const first = groups.flatMap((group) => group.entries).find((row) => !row.disabled)
                if (first) {
                  selectAccountSwitchRow(first)
                }
                return
              }
              if (!['ArrowDown', 'ArrowUp', 'Tab', 'Escape'].includes(event.key)) {
                event.stopPropagation()
              }
            }}
            onCompositionStart={() => searchIme.setComposing(true)}
            onCompositionEnd={(event) => searchIme.onCompositionEnd(event.data)}
            onKeyUp={searchIme.onKeyUp}
            onBlur={searchIme.reset}
            className="h-7 min-w-0 flex-1 rounded-none border-0 bg-transparent px-0 text-xs text-foreground shadow-none focus:bg-transparent focus-visible:border-0 focus-visible:ring-0 md:text-xs dark:bg-transparent dark:focus:bg-transparent"
          />
        </DropdownMenuItem>
      </label>
      <div className="max-h-[min(300px,40vh)] overflow-y-auto scrollbar-sleek">
        {groups.length === 0 ? (
          <div className="px-2.5 py-3 text-center text-2xs text-muted-foreground">
            {translate(
              'auto.components.status.bar.AccountSwitchList.noMatches',
              'No accounts match “{{query}}”',
              { query: query.trim() }
            )}
          </div>
        ) : (
          groups.map((group) => {
            const title = groupHeading(group.kind)
            return (
              <div key={group.kind}>
                {title ? (
                  <div className="sticky top-0 z-10 flex justify-between bg-popover px-2.5 pt-2 pb-0.5 text-3xs font-medium text-muted-foreground">
                    <span>{title}</span>
                    {group.kind === 'accounts' ? <span>{usageHeading}</span> : null}
                  </div>
                ) : null}
                {group.entries.map(renderRow)}
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}
