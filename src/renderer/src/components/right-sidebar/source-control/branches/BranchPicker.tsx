import { memo, type ReactNode } from 'react'
import { Check, ChevronDown, GitBranch } from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Command, CommandInput, CommandItem, CommandList } from '@/components/ui/command'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { useUiLanguageRevision } from '@/i18n/use-ui-language-revision'
import { formatUiRelativeTime } from '@/i18n/relative-time-format'
import type { BranchPickerRow } from './branch-picker-rows'
import { useBranchPicker, type BranchPickerOptions } from './use-branch-picker'

export type BranchPickerProps = BranchPickerOptions & {
  branch: string
  blocker: string | null
  agentHint?: ReactNode
}
export function BranchPicker({ branch, blocker, agentHint, ...options }: BranchPickerProps) {
  useUiLanguageRevision()
  const picker = useBranchPicker(options)
  const disabled = blocker !== null || picker.pending
  return (
    <Popover open={picker.open} onOpenChange={picker.setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={translate('sourceControl.branchPicker.switch', 'Switch branch: {{branch}}', {
            branch
          })}
          className="flex min-w-0 items-center gap-1 rounded-sm font-mono text-[10.5px] font-medium text-foreground outline-none focus-visible:ring-1 focus-visible:ring-ring"
        >
          <GitBranch className="size-3 shrink-0" />
          <span className="truncate">{branch}</span>
          <ChevronDown className="size-3 shrink-0" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80 p-0">
        <Command shouldFilter={false}>
          <CommandInput
            placeholder={translate('sourceControl.branchPicker.search', 'Search branches')}
            value={picker.query}
            onValueChange={picker.setQuery}
          />
          <CommandList>
            {picker.rows.map((row) => (
              <BranchRow
                key={`${row.target.kind}:${row.target.name}`}
                row={row}
                branch={branch}
                openedAt={picker.openedAt}
                pending={picker.pending}
                disabled={disabled}
                onSelect={picker.select}
              />
            ))}
          </CommandList>
        </Command>
        {picker.moreLocal && (
          <p className="px-3 py-2 text-xs text-muted-foreground">
            {translate('sourceControl.branchPicker.more', 'Keep typing to find more branches.')}
          </p>
        )}
        {picker.open && agentHint}
        {blocker && (
          <p role="status" className="border-t px-3 py-2 text-xs text-muted-foreground">
            {blocker}
          </p>
        )}
        {(picker.error || picker.discoveryError) && (
          <p role="alert" className="px-3 py-2 text-xs text-destructive">
            {picker.error ?? picker.discoveryError}
          </p>
        )}
        {picker.existingBranch && (
          <Button
            variant="ghost"
            disabled={disabled}
            onClick={() =>
              void picker.select({
                target: { kind: 'local', name: picker.existingBranch ?? '' },
                label: picker.existingBranch ?? ''
              })
            }
          >
            {translate('sourceControl.branchPicker.recover', 'Switch to {{branch}}', {
              branch: picker.existingBranch
            })}
          </Button>
        )}
      </PopoverContent>
    </Popover>
  )
}

const BranchRow = memo(function BranchRow({
  row,
  branch,
  openedAt,
  pending,
  disabled,
  onSelect
}: {
  row: BranchPickerRow
  branch: string
  openedAt: number
  pending: boolean
  disabled: boolean
  onSelect: (row: BranchPickerRow) => Promise<void>
}) {
  useUiLanguageRevision()
  return (
    <CommandItem
      value={`${row.target.kind}:${row.target.name}`}
      data-current={row.current ? 'true' : undefined}
      className="jump-palette-item"
      disabled={row.current || (row.workspace ? pending : disabled || Boolean(row.occupiedPath))}
      onSelect={() => void onSelect(row)}
    >
      <span className="min-w-0 flex-1 truncate">
        {row.target.kind === 'new'
          ? translate(
              'sourceControl.branchPicker.create',
              'Create branch {{name}} from {{branch}}',
              { name: row.label, branch }
            )
          : row.label}
      </span>
      {row.current ? (
        <Check className="size-3" />
      ) : row.workspace ? (
        <span className="text-xs text-muted-foreground">
          {translate('sourceControl.branchPicker.open', 'Open workspace')}
        </span>
      ) : row.occupiedPath ? (
        <span className="text-xs text-muted-foreground">
          {translate('sourceControl.branchPicker.occupied', 'Checked out in {{path}}', {
            path: row.occupiedPath
          })}
        </span>
      ) : row.target.kind === 'remote' ? (
        <span className="text-xs text-muted-foreground">
          {translate('sourceControl.branchPicker.remote', 'remote')}
        </span>
      ) : row.committedAt ? (
        <span className="text-xs text-muted-foreground">
          {formatUiRelativeTime(row.committedAt - openedAt)}
        </span>
      ) : null}
    </CommandItem>
  )
})
