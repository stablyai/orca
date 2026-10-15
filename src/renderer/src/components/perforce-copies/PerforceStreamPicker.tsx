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
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
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

/** `new`: branch a stream of its own; `existing`: work directly on a stream that is already there. */
type StreamMode = 'new' | 'existing'

function modeOf(choice: WorkspaceCopyStreamChoice): StreamMode {
  return choice.kind === 'child' ? 'new' : 'existing'
}

/** The stream a choice points at: the parent to branch from, or the stream the copy sits on. */
function chosenStream(choice: WorkspaceCopyStreamChoice, sourceStream: string): string {
  if (choice.kind === 'child') {
    return choice.parent ?? sourceStream
  }
  if (choice.kind === 'stream') {
    return choice.stream
  }
  return sourceStream
}

/** Picking `stream` under `mode`: a new child under it, or that stream worked on directly. */
function choiceFor(
  mode: StreamMode,
  stream: string,
  sourceStream: string
): WorkspaceCopyStreamChoice {
  if (mode === 'new') {
    return stream === sourceStream ? { kind: 'child' } : { kind: 'child', parent: stream }
  }
  return stream === sourceStream ? { kind: 'same-stream' } : { kind: 'stream', stream }
}

/**
 * "Create from" for a Perforce project: a tab bar picks whether the workspace branches a new stream
 * of its own (as Git branches from a base) or works directly on an existing stream, and the dropdown
 * picks that stream.
 */
export function PerforceStreamPicker({
  repoId,
  hostId,
  value,
  onChange
}: {
  repoId: string
  hostId: ExecutionHostId | null
  value: WorkspaceCopyStreamChoice
  onChange: (choice: WorkspaceCopyStreamChoice) => void
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
  const mode = modeOf(value)
  const streams = list
    ? [sourceStream, ...list.streams.map((entry) => entry.stream).filter((s) => s !== sourceStream)]
    : []
  const typeOf = new Map(list?.streams.map((entry) => [entry.stream, entry.type]) ?? [])
  const selected = chosenStream(value, sourceStream)

  return (
    <div className="space-y-1.5">
      <ToggleGroup
        type="single"
        variant="outline"
        value={mode}
        // Radix sends '' when the active item is re-clicked; keep the current mode then.
        onValueChange={(next) => {
          if (next) {
            onChange(choiceFor(next as StreamMode, sourceStream, sourceStream))
          }
        }}
        className="w-full"
      >
        <ToggleGroupItem value="new" className="flex-1">
          {translate('perforce.copies.modeNew', 'New stream')}
        </ToggleGroupItem>
        <ToggleGroupItem value="existing" className="flex-1">
          {translate('perforce.copies.modeExisting', 'Existing stream')}
        </ToggleGroupItem>
      </ToggleGroup>

      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            role="combobox"
            aria-expanded={open}
            aria-controls={listId}
            aria-label={translate('perforce.copies.streamField', 'Stream')}
            className={cn(
              COMBOBOX_FIELD_SHELL,
              'cursor-pointer justify-between text-left text-sm outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50'
            )}
          >
            <span className="truncate">
              {selected ? (
                <>
                  {streamShortName(selected)}
                  {selected === sourceStream ? (
                    <span className="text-muted-foreground">
                      {' · '}
                      {translate('perforce.copies.thisWorkspace', 'this workspace')}
                    </span>
                  ) : null}
                </>
              ) : (
                translate('perforce.copies.chooseStream', 'Choose a stream…')
              )}
            </span>
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
              {streams.length > 0 ? (
                <CommandGroup>
                  {streams.map((stream) => (
                    <CommandItem
                      key={stream}
                      value={stream}
                      onSelect={() => select(choiceFor(mode, stream, sourceStream))}
                    >
                      <Check
                        className={cn(
                          'size-3.5',
                          selected === stream ? 'opacity-100' : 'opacity-0'
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
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>

      <p className="text-xs text-muted-foreground">
        {mode === 'new'
          ? translate(
              'perforce.copies.modeNewHint',
              'A new stream of its own, branched from the stream above.'
            )
          : translate(
              'perforce.copies.modeExistingHint',
              'Works directly on the stream above — no new stream is created.'
            )}
      </p>
    </div>
  )
}
