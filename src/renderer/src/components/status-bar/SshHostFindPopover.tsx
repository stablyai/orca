import { useRef, useState, type RefObject } from 'react'
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList
} from '@/components/ui/command'
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import { canConnectSshStatus } from '@/ssh/ssh-connection-recoverability'
import { STATUS_LABELS, statusColor } from '../settings/SshTargetCard'
import { findSshHostMatches, type SshStatusMenuTarget } from './ssh-status-menu-rows'
import {
  moreSshHostMatchesLabel,
  noMatchingSshHostsLabel,
  searchSshHostsLabel
} from './ssh-status-segment-copy'
import { connectSshTargetFromStatusMenu } from './SshTargetStatusRow'

/** Searchable picker for the SSH hosts the Remote Hosts menu has no room to list. */
export function SshHostFindPopover({
  open,
  onOpenChange,
  targets,
  anchorRef
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  targets: readonly SshStatusMenuTarget[]
  anchorRef: RefObject<HTMLButtonElement | null>
}): React.JSX.Element {
  const [query, setQuery] = useState('')
  const dismissedByPointerRef = useRef(false)
  // Why own filtering: cmdk would mount and score an item per host, the DOM cost this avoids.
  const { matches, moreCount } = open
    ? findSshHostMatches(targets, query)
    : { matches: [], moreCount: 0 }

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          setQuery('')
        }
        onOpenChange(next)
      }}
    >
      <PopoverAnchor virtualRef={anchorRef} />
      <PopoverContent
        side="top"
        align="start"
        className="w-[min(20rem,calc(100vw-1rem))]"
        onOpenAutoFocus={() => {
          dismissedByPointerRef.current = false
        }}
        onPointerDownOutside={() => {
          dismissedByPointerRef.current = true
        }}
        onCloseAutoFocus={(event) => {
          // Why: an anchor is not a trigger, so Radix has nowhere to return focus; a keyboard
          // close goes back to the status button, a click elsewhere keeps what was clicked.
          event.preventDefault()
          if (!dismissedByPointerRef.current) {
            anchorRef.current?.focus()
          }
        }}
      >
        <Command shouldFilter={false} label={searchSshHostsLabel()}>
          <CommandInput
            value={query}
            onValueChange={setQuery}
            placeholder={searchSshHostsLabel()}
            aria-label={searchSshHostsLabel()}
          />
          <CommandList>
            <CommandEmpty>{noMatchingSshHostsLabel()}</CommandEmpty>
            {matches.map((target) => (
              <CommandItem
                key={target.id}
                value={target.id}
                selection="palette"
                disabled={!canConnectSshStatus(target.status)}
                onSelect={() => {
                  onOpenChange(false)
                  setQuery('')
                  void connectSshTargetFromStatusMenu(target.id)
                }}
              >
                <span
                  className={cn('size-1.5 shrink-0 rounded-full', statusColor(target.status))}
                />
                <span className="min-w-0 flex-1 truncate">{target.label}</span>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {STATUS_LABELS[target.status]}
                </span>
              </CommandItem>
            ))}
          </CommandList>
          {moreCount > 0 ? (
            <div className="border-t border-border px-3 py-2 text-xs text-muted-foreground">
              {moreSshHostMatchesLabel(moreCount)}
            </div>
          ) : null}
        </Command>
      </PopoverContent>
    </Popover>
  )
}
