import React from 'react'
import {
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import type {
  DropdownActionKind,
  DropdownEntry,
  DropdownItem
} from './source-control-dropdown-items'

/**
 * Shared renderer for the commit split-button menu. Both `CommitArea` and
 * `CreateHostedReviewComposer` consume the same `DropdownEntry[]`, so the row
 * markup lives here — otherwise a new entry variant silently breaks whichever
 * consumer wasn't updated.
 *
 * `withTooltips` matches the existing difference between the two surfaces: the
 * commit area wraps each row in a tooltip (its titles double as disabled
 * reasons), the composer relies on the native title attribute.
 */
export function SourceControlDropdownEntries({
  entries,
  onAction,
  withTooltips = false
}: {
  entries: DropdownEntry[]
  onAction: (kind: DropdownActionKind) => void
  withTooltips?: boolean
}): React.JSX.Element {
  return (
    <>
      {entries.map((entry, index) => {
        if (entry.kind === 'separator') {
          return <DropdownMenuSeparator key={`sep-${index}`} />
        }
        if (entry.kind === 'stash_submenu') {
          return (
            <DropdownMenuSub key={entry.kind}>
              <DropdownMenuSubTrigger
                disabled={entry.disabled}
                title={entry.title}
                data-testid="source-control-stash-submenu-trigger"
              >
                {entry.label}
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="min-w-[15rem]">
                {entry.items.map((item, itemIndex) =>
                  item.kind === 'separator' ? (
                    <DropdownMenuSeparator key={`stash-sep-${itemIndex}`} />
                  ) : (
                    renderRow(item, onAction, withTooltips)
                  )
                )}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          )
        }
        return renderRow(entry, onAction, withTooltips)
      })}
    </>
  )
}

function renderRow(
  entry: DropdownItem,
  onAction: (kind: DropdownActionKind) => void,
  withTooltips: boolean
): React.JSX.Element {
  const item = (
    <DropdownMenuItem
      disabled={entry.disabled}
      title={entry.title}
      variant={entry.variant}
      className={withTooltips ? 'w-full' : undefined}
      data-testid={`source-control-dropdown-${entry.kind}`}
      onSelect={(event) => {
        if (entry.disabled) {
          event.preventDefault()
          return
        }
        onAction(entry.kind)
      }}
    >
      <span className="flex min-w-0 flex-col">
        <span>{entry.label}</span>
        {entry.hint ? (
          <span className="truncate text-[10px] text-muted-foreground">{entry.hint}</span>
        ) : null}
      </span>
    </DropdownMenuItem>
  )

  if (!withTooltips) {
    return <React.Fragment key={entry.kind}>{item}</React.Fragment>
  }
  return (
    <Tooltip key={entry.kind}>
      <TooltipTrigger asChild>
        <div className="block">{item}</div>
      </TooltipTrigger>
      <TooltipContent side="left" sideOffset={8} className="max-w-72">
        {entry.title}
      </TooltipContent>
    </Tooltip>
  )
}
