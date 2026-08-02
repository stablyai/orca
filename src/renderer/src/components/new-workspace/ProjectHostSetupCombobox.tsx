import React from 'react'
import { Check, ChevronsUpDown, Server } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Command, CommandEmpty, CommandItem, CommandList } from '@/components/ui/command'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import type { ProjectHostSetupOption } from '@/lib/project-host-setup-options'
import { translate } from '@/i18n/i18n'

type ProjectHostSetupComboboxProps = {
  options: readonly ProjectHostSetupOption[]
  value: string | null
  onValueChange: (setupId: string) => void
}

export default function ProjectHostSetupCombobox({
  options,
  value,
  onValueChange
}: ProjectHostSetupComboboxProps): React.JSX.Element {
  const [open, setOpen] = React.useState(false)
  const readyOptions = options.filter((option) => option.kind === 'ready')
  const selected = readyOptions.find((option) => option.id === value) ?? readyOptions[0] ?? null

  const handleSelect = React.useCallback(
    (setupId: string): void => {
      const option = options.find((candidate) => candidate.id === setupId)
      if (!option) {
        return
      }
      if (!readyOptions.some((candidate) => candidate.id === setupId)) {
        return
      }
      onValueChange(setupId)
      setOpen(false)
    },
    [onValueChange, options, readyOptions]
  )

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          className="h-9 w-full justify-between border-input px-3 text-sm font-normal focus:border-ring focus:ring-[3px] focus:ring-ring/50"
        >
          {selected ? (
            <span className="inline-flex min-w-0 items-center gap-1.5">
              <Server className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="truncate">{selected.label}</span>
            </span>
          ) : (
            <span className="text-muted-foreground">
              {translate(
                'auto.components.new.workspace.ProjectHostSetupCombobox.placeholder',
                'Choose host'
              )}
            </span>
          )}
          <ChevronsUpDown className="size-3.5 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-[var(--radix-popover-trigger-width)] min-w-[18rem] p-0"
      >
        <Command value={selected?.id ?? ''}>
          <CommandList>
            <CommandEmpty>
              {translate(
                'auto.components.new.workspace.ProjectHostSetupCombobox.empty',
                'No hosts are ready for this project.'
              )}
            </CommandEmpty>
            {readyOptions.map((option) => (
              <CommandItem
                key={option.id}
                value={option.id}
                onSelect={() => handleSelect(option.id)}
                className="items-center gap-2 px-3 py-2"
              >
                <Check
                  className={cn(
                    'size-4 text-foreground',
                    option.id === selected?.id ? 'opacity-100' : 'opacity-0'
                  )}
                />
                <Server className="size-3.5 shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm">{option.label}</div>
                  <div className="mt-0.5 truncate text-[11px] text-muted-foreground">
                    {option.path}
                  </div>
                </div>
              </CommandItem>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
