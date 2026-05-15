import React from 'react'
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
import type { Worktree } from '../../../../shared/types'

export function WorkspaceCombobox({
  worktrees,
  value,
  triggerClassName,
  onValueChange
}: {
  worktrees: Worktree[]
  value: string
  triggerClassName?: string
  onValueChange: (workspaceId: string) => void
}): React.JSX.Element {
  const [open, setOpen] = React.useState(false)
  const inputRef = React.useRef<HTMLInputElement | null>(null)
  const selected = worktrees.find((worktree) => worktree.id === value) ?? null

  React.useEffect(() => {
    if (!open) {
      return
    }
    const frame = requestAnimationFrame(() => inputRef.current?.focus())
    return () => cancelAnimationFrame(frame)
  }, [open])

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          className={cn('h-9 w-full justify-between px-3 text-sm font-normal', triggerClassName)}
        >
          <span className={cn('truncate', !selected && 'text-muted-foreground')}>
            {selected?.displayName ?? 'Select workspace'}
          </span>
          <ChevronsUpDown className="size-4 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-[var(--radix-popover-trigger-width)] min-w-[18rem] p-0"
        onOpenAutoFocus={(event) => event.preventDefault()}
      >
        <Command>
          <CommandInput ref={inputRef} placeholder="Search workspaces..." />
          <CommandList className="max-h-72">
            <CommandEmpty>No workspaces found.</CommandEmpty>
            {worktrees.map((worktree) => (
              <CommandItem
                key={worktree.id}
                value={worktree.displayName}
                onSelect={() => {
                  onValueChange(worktree.id)
                  setOpen(false)
                }}
              >
                <Check
                  className={cn('size-4', value === worktree.id ? 'opacity-100' : 'opacity-0')}
                />
                <span className="truncate">{worktree.displayName}</span>
              </CommandItem>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
