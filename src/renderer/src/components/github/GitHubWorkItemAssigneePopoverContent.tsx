import React, { useEffect, useMemo, useState } from 'react'
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList
} from '@/components/ui/command'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import type { GitHubAssignableUser } from '../../../../shared/types'
import { filterGitHubWorkItemAssignees } from './github-work-item-assignee-filter'

const assigneeCheckIcon = (
  <svg className="size-2.5" viewBox="0 0 12 12" fill="none">
    <path
      d="M2 6l3 3 5-5"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
)

export function GitHubWorkItemAssigneePopoverContent({
  open,
  assignees,
  selectedLogins,
  error,
  loading,
  onToggleAssignee
}: {
  open: boolean
  assignees: readonly GitHubAssignableUser[]
  selectedLogins: readonly string[]
  error: string | null | undefined
  loading?: boolean
  onToggleAssignee: (login: string) => void
}): React.JSX.Element {
  const [query, setQuery] = useState('')
  const filteredAssignees = useMemo(
    () => filterGitHubWorkItemAssignees(assignees, query),
    [assignees, query]
  )
  const selectedSet = useMemo(() => new Set(selectedLogins), [selectedLogins])

  useEffect(() => {
    if (!open) {
      setQuery('')
    }
  }, [open])

  if (error) {
    return <div className="px-2 py-3 text-center text-[12px] text-destructive">{error}</div>
  }

  const emptyText = loading
    ? translate(
        'auto.components.github.GitHubWorkItemAssigneePopoverContent.cddd9b04a7',
        'Loading assignees'
      )
    : translate(
        'auto.components.github.GitHubWorkItemAssigneePopoverContent.a00830d3f7',
        'No users'
      )

  return (
    <Command shouldFilter={false} className="bg-transparent">
      <CommandInput
        placeholder={translate(
          'auto.components.github.GitHubWorkItemAssigneePopoverContent.4f8b6f2c1d',
          'Filter assignees...'
        )}
        value={query}
        onValueChange={setQuery}
        className="h-8 text-[12px]"
        wrapperClassName="border-b border-border/60 px-2"
        iconClassName="size-3.5"
      />
      <CommandList className="max-h-60">
        <CommandEmpty className="px-2 py-3 text-center text-[12px] text-muted-foreground">
          {emptyText}
        </CommandEmpty>
        {filteredAssignees.map((user) => {
          const isSelected = selectedSet.has(user.login)
          return (
            <CommandItem
              key={user.login}
              value={user.login}
              onSelect={() => onToggleAssignee(user.login)}
              className="flex items-center gap-2 rounded-sm px-2 py-1.5 text-[12px]"
            >
              <span
                className={cn(
                  'flex size-3.5 items-center justify-center rounded-sm border',
                  isSelected ? 'border-primary bg-primary text-primary-foreground' : 'border-input'
                )}
              >
                {isSelected ? assigneeCheckIcon : null}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate">{user.login}</span>
                {user.name ? (
                  <span className="block truncate text-[11px] text-muted-foreground">
                    {user.name}
                  </span>
                ) : null}
              </span>
            </CommandItem>
          )
        })}
      </CommandList>
    </Command>
  )
}
