import { useEffect, useId, useState } from 'react'
import { Check, ChevronsUpDown, LoaderCircle } from 'lucide-react'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList
} from '@/components/ui/command'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import { COMBOBOX_FIELD_SHELL } from '../new-workspace/type-ahead-combobox-styles'
import type {
  PerforceStreamList,
  WorkspaceCopyStreamChoice
} from '../../../../shared/perforce/workspace-copy/workspace-copy-types'
import { streamShortName } from '../../../../shared/perforce/workspace-copy/workspace-copy-name-rules'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import { runPerforceCopyOperation } from '../../runtime/runtime-perforce-client'
import { perforceProjectTarget } from '@/lib/perforce-workspace-target'

function choiceLabel(choice: WorkspaceCopyStreamChoice, sourceStream: string): string {
  if (choice.kind === 'same-stream') {
    return translate('perforce.copies.directlyOnStream', '{{stream}} directly (no new stream)', {
      stream: streamShortName(sourceStream)
    })
  }
  const parent = choice.kind === 'child' ? (choice.parent ?? sourceStream) : choice.stream
  return translate('perforce.copies.newStreamFrom', 'New stream from {{stream}}', {
    stream: streamShortName(parent)
  })
}

function isSelected(value: WorkspaceCopyStreamChoice, stream: string, sourceStream: string) {
  return value.kind === 'child' && (value.parent ?? sourceStream) === stream
}

/**
 * "Create from" for a Perforce project: the parent stream the new workspace's own stream branches
 * from (the workspace's stream by default), as Git branches from a base, or its stream directly.
 */
export function PerforceStreamPicker({
  repoId,
  hostId,
  value,
  onChange,
  labelId
}: {
  repoId: string
  hostId: ExecutionHostId | null
  value: WorkspaceCopyStreamChoice
  onChange: (choice: WorkspaceCopyStreamChoice) => void
  labelId: string
}) {
  const [open, setOpen] = useState(false)
  const listId = useId()
  const [list, setList] = useState<PerforceStreamList | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setList(null)
    setError(null)
    void runPerforceCopyOperation(
      perforceProjectTarget(repoId, hostId),
      'listCopyStreams',
      {}
    ).then((result) => {
      if (cancelled) {
        return
      }
      if (result.ok) {
        setList(result.value)
      } else {
        setError(result.error)
      }
    })
    return () => {
      cancelled = true
    }
  }, [repoId, hostId])

  const select = (choice: WorkspaceCopyStreamChoice): void => {
    onChange(choice)
    setOpen(false)
  }
  const sourceStream = list?.sourceStream ?? ''
  const parents = list
    ? [sourceStream, ...list.streams.map((entry) => entry.stream).filter((s) => s !== sourceStream)]
    : []
  const typeOf = new Map(list?.streams.map((entry) => [entry.stream, entry.type]) ?? [])

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          aria-labelledby={labelId}
          className={cn(
            COMBOBOX_FIELD_SHELL,
            'cursor-pointer justify-between text-left text-sm outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50'
          )}
        >
          <span className="truncate">{choiceLabel(value, sourceStream)}</span>
          <ChevronsUpDown className="size-3.5 shrink-0 opacity-50" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="flex w-[var(--radix-popover-trigger-width)] min-w-[17rem] flex-col"
      >
        <Command>
          <CommandInput
            placeholder={translate('perforce.copies.searchStreams', 'Search streams…')}
          />
          <CommandList id={listId}>
            <CommandEmpty>
              {translate('perforce.copies.noMatchingStream', 'No matching stream.')}
            </CommandEmpty>
            {!list && !error ? (
              <div className="flex items-center gap-2 px-3 py-2 text-xs text-muted-foreground">
                <LoaderCircle className="size-3.5 animate-spin" />
                {translate('perforce.copies.loadingStreams', 'Loading streams…')}
              </div>
            ) : null}
            {error ? <p className="px-3 py-2 text-xs text-destructive">{error}</p> : null}
            {parents.length > 0 ? (
              <CommandGroup
                heading={translate('perforce.copies.newStreamFromHeading', 'New stream from')}
              >
                {parents.map((stream) => (
                  <CommandItem
                    key={stream}
                    value={stream}
                    onSelect={() =>
                      select(
                        stream === sourceStream
                          ? { kind: 'child' }
                          : { kind: 'child', parent: stream }
                      )
                    }
                  >
                    <Check
                      className={cn(
                        'size-3.5',
                        isSelected(value, stream, sourceStream) ? 'opacity-100' : 'opacity-0'
                      )}
                    />
                    <span className="min-w-0 flex-1 truncate">{streamShortName(stream)}</span>
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {stream === sourceStream
                        ? translate('perforce.copies.thisWorkspace', 'this workspace')
                        : typeOf.get(stream)}
                    </span>
                  </CommandItem>
                ))}
              </CommandGroup>
            ) : null}
            {list ? (
              <CommandGroup
                heading={translate('perforce.copies.directlyHeading', 'Work directly on')}
              >
                <CommandItem
                  value={`${sourceStream} directly`}
                  onSelect={() => select({ kind: 'same-stream' })}
                >
                  <Check
                    className={cn(
                      'size-3.5',
                      value.kind === 'same-stream' ? 'opacity-100' : 'opacity-0'
                    )}
                  />
                  <span className="truncate">
                    {choiceLabel({ kind: 'same-stream' }, sourceStream)}
                  </span>
                </CommandItem>
              </CommandGroup>
            ) : null}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
