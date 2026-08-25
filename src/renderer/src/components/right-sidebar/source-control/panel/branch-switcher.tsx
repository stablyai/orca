import React from 'react'
import { Check, GitBranch, Loader2, Plus } from 'lucide-react'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList
} from '@/components/ui/command'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import type { SourceControlBranchSwitch } from '../sync/use-branch-switch'
import type { BranchPickerRow } from './branch-picker-rows'

function CreateRow({
  row,
  disabled,
  onSelect
}: {
  row: Extract<BranchPickerRow, { kind: 'create' }>
  disabled: boolean
  onSelect: () => void
}): React.JSX.Element {
  return (
    <CommandItem
      value={`create:${row.name}`}
      disabled={disabled || row.rejection !== null}
      onSelect={onSelect}
    >
      <Plus className="size-3.5" aria-hidden="true" />
      <span className="min-w-0 flex-1 truncate font-mono text-[11px]">
        {translate(
          'auto.components.right.sidebar.SourceControl.4ec1304f7b',
          'Create branch {{value0}}',
          { value0: row.name }
        )}
      </span>
      {row.rejection !== null ? (
        <span className="shrink-0 text-[10px] text-muted-foreground">
          {translate('auto.components.right.sidebar.SourceControl.96fb1f9512', 'Invalid branch name')}
        </span>
      ) : null}
    </CommandItem>
  )
}

function BranchRow({
  row,
  disabled,
  onSelect
}: {
  row: Extract<BranchPickerRow, { kind: 'branch' }>
  disabled: boolean
  onSelect: () => void
}): React.JSX.Element {
  // Why: git refuses to check a branch out in two worktrees, so an occupied row
  // is inert rather than a checkout that is guaranteed to fail.
  const blocked = row.occupiedBy !== null
  return (
    <CommandItem
      value={`branch:${row.name}`}
      disabled={disabled || blocked || row.isCurrent}
      onSelect={onSelect}
    >
      {row.isCurrent ? (
        <Check className="size-3.5" aria-hidden="true" />
      ) : (
        <GitBranch className="size-3.5 opacity-60" aria-hidden="true" />
      )}
      <span className="min-w-0 flex-1 truncate font-mono text-[11px]">{row.name}</span>
      {row.isCurrent ? (
        <span className="shrink-0 text-[10px] text-muted-foreground">
          {translate('auto.components.right.sidebar.SourceControl.97b0560280', 'current')}
        </span>
      ) : null}
      {blocked ? (
        <span className="min-w-0 max-w-28 shrink-0 truncate text-[10px] text-muted-foreground">
          {translate(
            'auto.components.right.sidebar.SourceControl.419ab6fb4e',
            'Checked out in {{value0}}',
            { value0: row.occupiedBy ?? '' }
          )}
        </span>
      ) : null}
    </CommandItem>
  )
}

/**
 * The HEAD branch name as a picker trigger. Renders the same text the static
 * identity did, so the header reads identically until it is activated.
 */
export function SourceControlBranchSwitcher({
  branchName,
  branchSwitch
}: {
  branchName: string
  branchSwitch: SourceControlBranchSwitch
}): React.JSX.Element {
  const { isBusy, isLoading, isOpen, onOpenChange, query, rows, setQuery } = branchSwitch

  return (
    <Popover open={isOpen} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            'block min-w-0 max-w-full truncate rounded-sm border-0 bg-transparent p-0 text-left font-mono text-[10.5px] font-medium text-foreground/90',
            'underline decoration-transparent underline-offset-2 outline-none',
            'hover:decoration-border focus-visible:ring-1 focus-visible:ring-ring'
          )}
          aria-label={translate(
            'auto.components.right.sidebar.SourceControl.e000af1035',
            'Current branch: {{value0}}. Activate to switch branch.',
            { value0: branchName }
          )}
          data-testid="source-control-head-identity"
        >
          {branchName}
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" side="bottom" sideOffset={6} className="w-72 p-0">
        {/* Why: rows are already filtered against the typed query, and cmdk's own
            fuzzy pass would additionally hide the create row for a novel name. */}
        <Command shouldFilter={false}>
          <CommandInput
            value={query}
            onValueChange={setQuery}
            placeholder={translate(
              'auto.components.right.sidebar.SourceControl.22f3ebc156',
              'Search or create branch…'
            )}
            trailing={
              isBusy || isLoading ? (
                <Loader2 className="size-3.5 animate-spin opacity-60" aria-hidden="true" />
              ) : null
            }
          />
          <CommandList>
            {isLoading ? (
              <div className="px-3 py-4 text-center text-[11px] text-muted-foreground">
                {translate(
                  'auto.components.right.sidebar.SourceControl.55704e8f60',
                  'Loading branches…'
                )}
              </div>
            ) : (
              <CommandEmpty>
                {translate(
                  'auto.components.right.sidebar.SourceControl.68f9e0ee45',
                  'No matching branches'
                )}
              </CommandEmpty>
            )}
            {rows.map((row) =>
              row.kind === 'create' ? (
                <CreateRow
                  key={`create:${row.name}`}
                  row={row}
                  disabled={isBusy}
                  onSelect={() => branchSwitch.createBranch(row.name)}
                />
              ) : (
                <BranchRow
                  key={`branch:${row.name}`}
                  row={row}
                  disabled={isBusy}
                  onSelect={() => branchSwitch.switchToBranch(row.name)}
                />
              )
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
