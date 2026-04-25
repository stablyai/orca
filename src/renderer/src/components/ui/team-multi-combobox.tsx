import React, { useCallback, useMemo, useState } from 'react'
import { Check, ChevronsUpDown } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList
} from '@/components/ui/command'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import type { LinearTeam } from '../../../../shared/types'

type TeamMultiComboboxProps = {
  teams: LinearTeam[]
  selected: ReadonlySet<string>
  onChange: (next: ReadonlySet<string>) => void
  onSelectAll: () => void
  triggerClassName?: string
}

function renderTriggerLabel(teams: LinearTeam[], selected: ReadonlySet<string>): React.JSX.Element {
  if (teams.length === 0) {
    return <span className="text-muted-foreground">No teams</span>
  }
  if (selected.size === teams.length) {
    return <span className="inline-flex min-w-0 items-center gap-1.5">All teams</span>
  }
  const selectedTeams = teams.filter((t) => selected.has(t.id))
  const [first, second, ...rest] = selectedTeams
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5 truncate">
      {first ? <span>{first.key}</span> : null}
      {second ? <span className="text-muted-foreground">, {second.key}</span> : null}
      {rest.length > 0 ? <span className="text-muted-foreground">+{rest.length}</span> : null}
    </span>
  )
}

export default function TeamMultiCombobox({
  teams,
  selected,
  onChange,
  onSelectAll,
  triggerClassName
}: TeamMultiComboboxProps): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [commandValue, setCommandValue] = useState('')

  const filteredTeams = useMemo(() => {
    if (!query) {
      return teams
    }
    const lower = query.toLowerCase()
    return teams.filter(
      (t) => t.name.toLowerCase().includes(lower) || t.key.toLowerCase().includes(lower)
    )
  }, [teams, query])

  const allSelected = selected.size === teams.length && teams.length > 0

  const handleOpenChange = useCallback((nextOpen: boolean) => {
    setOpen(nextOpen)
    if (!nextOpen) {
      setQuery('')
    }
  }, [])

  const toggle = useCallback(
    (teamId: string) => {
      const next = new Set(selected)
      if (next.has(teamId)) {
        if (next.size <= 1) {
          return
        }
        next.delete(teamId)
      } else {
        next.add(teamId)
      }
      onChange(next)
    },
    [onChange, selected]
  )

  const handleSelectAll = useCallback(() => {
    if (allSelected) {
      const first = teams[0]
      if (!first) {
        return
      }
      onChange(new Set([first.id]))
      return
    }
    onSelectAll()
  }, [allSelected, onChange, onSelectAll, teams])

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          className={cn('h-8 w-full justify-between px-3 text-xs font-normal', triggerClassName)}
        >
          {renderTriggerLabel(teams, selected)}
          <ChevronsUpDown className="size-3.5 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[var(--radix-popover-trigger-width)] p-0">
        <Command shouldFilter={false} value={commandValue} onValueChange={setCommandValue}>
          <CommandInput
            autoFocus
            placeholder="Search teams..."
            value={query}
            onValueChange={setQuery}
            className="text-xs"
          />
          <div className="border-b border-border">
            <button
              type="button"
              onClick={handleSelectAll}
              onMouseDown={(event) => event.preventDefault()}
              onMouseEnter={() => setCommandValue('')}
              className={cn(
                'flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-foreground transition-colors hover:bg-accent hover:text-accent-foreground',
                allSelected && 'opacity-80'
              )}
            >
              <Check
                className={cn(
                  'size-3 text-muted-foreground',
                  allSelected ? 'opacity-70' : 'opacity-0'
                )}
              />
              <span>All teams</span>
            </button>
          </div>
          <CommandList>
            <CommandEmpty>No teams match your search.</CommandEmpty>
            {filteredTeams.map((team) => {
              const isSelected = selected.has(team.id)
              const isLastSelected = isSelected && selected.size <= 1
              return (
                <CommandItem
                  key={team.id}
                  value={team.id}
                  onSelect={() => toggle(team.id)}
                  disabled={isLastSelected}
                  className="items-center gap-2 px-3 py-1.5 text-xs"
                >
                  <Check
                    className={cn(
                      'size-3 text-muted-foreground',
                      isSelected ? 'opacity-70' : 'opacity-0'
                    )}
                  />
                  <div className="min-w-0 flex-1">
                    <span className="inline-flex items-center gap-1.5 text-xs">
                      <span>{team.name}</span>
                      <span className="shrink-0 rounded bg-muted px-1 py-0.5 text-[9px] font-medium leading-none text-muted-foreground">
                        {team.key}
                      </span>
                    </span>
                  </div>
                </CommandItem>
              )
            })}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
