import React, { useCallback, useMemo, useState } from 'react'
import { Check, ChevronsUpDown, FolderOpen, FolderPlus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList
} from '@/components/ui/command'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import RepoBadgeLabel from '@/components/repo/RepoBadgeLabel'
import { cn } from '@/lib/utils'
import {
  searchNewWorkspaceProjectOptions,
  type NewWorkspaceProjectOption
} from '@/lib/new-workspace-project-options'
import { translate } from '@/i18n/i18n'

type ProjectComboboxProps = {
  options: readonly NewWorkspaceProjectOption[]
  value: string | null
  onValueChange: (projectId: string) => void
  onValueSelected?: (projectId: string) => void
  onAddProject?: () => void
  placeholder?: string
  triggerClassName?: string
  invalid?: boolean
  describedBy?: string
}

export default function ProjectCombobox({
  options,
  value,
  onValueChange,
  onValueSelected,
  onAddProject,
  placeholder = 'Choose project',
  triggerClassName,
  invalid = false,
  describedBy
}: ProjectComboboxProps): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [commandValue, setCommandValue] = useState('')
  const inputRef = React.useRef<HTMLInputElement | null>(null)
  const focusFrameRef = React.useRef<number | null>(null)
  const selectedProject = useMemo(
    () => options.find((option) => option.id === value) ?? null,
    [options, value]
  )
  const filteredOptions = useMemo(
    () => searchNewWorkspaceProjectOptions(options, query),
    [options, query]
  )

  const cancelFocusFrame = useCallback((): void => {
    if (focusFrameRef.current !== null) {
      cancelAnimationFrame(focusFrameRef.current)
      focusFrameRef.current = null
    }
  }, [])

  const setInputNode = useCallback(
    (node: HTMLInputElement | null): void => {
      if (node === null) {
        cancelFocusFrame()
      }
      inputRef.current = node
    },
    [cancelFocusFrame]
  )

  const focusSearchInput = useCallback((): void => {
    cancelFocusFrame()
    focusFrameRef.current = requestAnimationFrame(() => {
      focusFrameRef.current = null
      inputRef.current?.focus()
    })
  }, [cancelFocusFrame])

  const handleOpenChange = useCallback(
    (nextOpen: boolean): void => {
      setOpen(nextOpen)
      if (nextOpen) {
        setCommandValue(value ?? '')
        return
      }
      cancelFocusFrame()
      setQuery('')
    },
    [cancelFocusFrame, value]
  )

  const handleSelect = useCallback(
    (projectId: string): void => {
      onValueChange(projectId)
      setOpen(false)
      setQuery('')
      onValueSelected?.(projectId)
    },
    [onValueChange, onValueSelected]
  )

  const handleAddProject = useCallback((): void => {
    setOpen(false)
    setQuery('')
    onAddProject?.()
  }, [onAddProject])

  const handleTriggerKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLButtonElement>): void => {
      if (open) {
        return
      }
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault()
        setCommandValue(value ?? '')
        setOpen(true)
        return
      }
      if (event.metaKey || event.ctrlKey || event.altKey) {
        return
      }
      if (event.key.length === 1 && /\S/.test(event.key)) {
        event.preventDefault()
        setCommandValue(value ?? '')
        setQuery(event.key)
        setOpen(true)
      }
    },
    [open, value]
  )

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          aria-invalid={invalid ? true : undefined}
          aria-describedby={describedBy}
          onKeyDown={handleTriggerKeyDown}
          className={cn(
            'h-8 min-w-[184px] justify-between px-3 text-xs font-normal',
            triggerClassName
          )}
          data-project-combobox-root="true"
        >
          {selectedProject ? (
            selectedProject.kind === 'project-group' ? (
              <span className="flex min-w-0 items-center gap-1.5">
                <FolderOpen className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="truncate">{selectedProject.displayName}</span>
              </span>
            ) : (
              <RepoBadgeLabel
                name={selectedProject.displayName}
                color={selectedProject.badgeColor}
                badgeClassName="size-1.5"
              />
            )
          ) : (
            <span className="text-muted-foreground">{placeholder}</span>
          )}
          <ChevronsUpDown className="size-3.5 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-[var(--radix-popover-trigger-width)] min-w-[18rem] p-0"
        data-project-combobox-root="true"
        onOpenAutoFocus={(event) => {
          event.preventDefault()
          focusSearchInput()
        }}
      >
        <Command shouldFilter={false} value={commandValue} onValueChange={setCommandValue}>
          <CommandInput
            ref={setInputNode}
            placeholder={translate(
              'auto.components.new.workspace.ProjectCombobox.search',
              'Search projects...'
            )}
            value={query}
            onValueChange={setQuery}
          />
          <CommandList>
            <CommandEmpty>
              {translate(
                'auto.components.new.workspace.ProjectCombobox.empty',
                'No projects match your search.'
              )}
            </CommandEmpty>
            {filteredOptions.map((option) => (
              <CommandItem
                key={option.id}
                value={option.id}
                onSelect={() => handleSelect(option.id)}
                className="items-center gap-2 px-3 py-2"
              >
                <Check
                  className={cn(
                    'size-4 text-foreground',
                    option.id === value ? 'opacity-100' : 'opacity-0'
                  )}
                />
                <div className="min-w-0 flex-1">
                  {option.kind === 'project-group' ? (
                    <div className="flex min-w-0 items-center gap-1.5 text-sm">
                      <FolderOpen className="size-3.5 shrink-0 text-muted-foreground" />
                      <span className="truncate">{option.displayName}</span>
                    </div>
                  ) : (
                    <RepoBadgeLabel
                      name={option.displayName}
                      color={option.badgeColor}
                      className="max-w-full"
                    />
                  )}
                  <p className="mt-0.5 truncate text-[11px] text-muted-foreground">
                    {option.detail}
                  </p>
                </div>
              </CommandItem>
            ))}
          </CommandList>
          {onAddProject ? (
            // Why: pinned below the scrollable list so "Add a new project" stays
            // reachable in every state, including when the list is empty and
            // CommandEmpty shows "No projects match your search."
            <div className="border-t border-border">
              <Button
                type="button"
                variant="ghost"
                onClick={handleAddProject}
                onMouseDown={(event) => event.preventDefault()}
                onMouseEnter={() => setCommandValue('')}
                className="h-8 w-full justify-start rounded-none px-3 text-xs font-normal"
              >
                <FolderPlus className="size-3.5 text-muted-foreground" />
                <span>
                  {translate(
                    'auto.components.new.workspace.ProjectCombobox.addProject',
                    'Add a new project'
                  )}
                </span>
              </Button>
            </div>
          ) : null}
        </Command>
      </PopoverContent>
    </Popover>
  )
}
