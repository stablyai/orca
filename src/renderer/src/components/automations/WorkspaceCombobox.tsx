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
import { translate } from '@/i18n/i18n'

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
  const focusFrameRef = React.useRef<number | null>(null)
  const selected = worktrees.find((worktree) => worktree.id === value) ?? null

  const cancelFocusFrame = React.useCallback((): void => {
    if (focusFrameRef.current !== null) {
      cancelAnimationFrame(focusFrameRef.current)
      focusFrameRef.current = null
    }
  }, [])

  const setInputNode = React.useCallback(
    (node: HTMLInputElement | null): void => {
      if (node === null) {
        cancelFocusFrame()
      }
      inputRef.current = node
    },
    [cancelFocusFrame]
  )

  const focusSearchInput = React.useCallback(() => {
    cancelFocusFrame()
    focusFrameRef.current = requestAnimationFrame(() => {
      focusFrameRef.current = null
      inputRef.current?.focus()
    })
  }, [cancelFocusFrame])

  const handleOpenChange = React.useCallback(
    (nextOpen: boolean) => {
      setOpen(nextOpen)
      if (!nextOpen) {
        cancelFocusFrame()
      }
    },
    [cancelFocusFrame]
  )

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          className={cn('h-9 w-full justify-between px-3 text-sm font-normal', triggerClassName)}
        >
          <span className={cn('truncate', !selected && 'text-muted-foreground')}>
            {selected?.displayName ?? translate("auto.components.automations.WorkspaceCombobox.66a0cd9628", "Select workspace")}
          </span>
          <ChevronsUpDown className="size-4 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-[var(--radix-popover-trigger-width)] min-w-[18rem] p-0"
        onOpenAutoFocus={(event) => {
          event.preventDefault()
          focusSearchInput()
        }}
      >
        <Command>
          <CommandInput ref={setInputNode} placeholder={translate("auto.components.automations.WorkspaceCombobox.8e9c8cc6b5", "Search workspaces...")} />
          <CommandList className="max-h-72">
            <CommandEmpty>{translate("auto.components.automations.WorkspaceCombobox.ee5b280eba", "No workspaces found.")}</CommandEmpty>
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
