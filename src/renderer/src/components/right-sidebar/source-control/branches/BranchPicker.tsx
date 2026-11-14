import { memo, type ReactNode } from 'react'
import { Check, ChevronDown, Copy, GitBranch, Info } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Command, CommandInput, CommandItem, CommandList } from '@/components/ui/command'
import { useIntlLocale, useTranslate } from '@/i18n/use-translate'
import { useUiLanguageRevision } from '@/i18n/use-ui-language-revision'
import { formatUiRelativeTime } from '@/i18n/relative-time-format'
import type { BranchPickerRow } from './branch-picker-rows'
import { useBranchPicker, type BranchPickerOptions } from './use-branch-picker'

export type BranchPickerProps = BranchPickerOptions & {
  branch: string
  blocker: string | null
  dirtyOnlyBlocker?: boolean
  /** Replaces the header trigger; it must forward a ref and props to a button. */
  trigger?: ReactNode
  /** Adds a copy button to the current branch's row. */
  onCopyBranch?: () => void
}
export function BranchPicker({
  branch,
  blocker,
  dirtyOnlyBlocker = false,
  trigger,
  onCopyBranch,
  ...options
}: BranchPickerProps) {
  const t = useTranslate()
  useUiLanguageRevision()
  const picker = useBranchPicker(options)
  const disabled = blocker !== null || picker.pending
  return (
    <Popover open={picker.open} onOpenChange={picker.setOpen}>
      <PopoverTrigger asChild>
        {trigger ?? (
          <button
            type="button"
            aria-label={t('sourceControl.branchPicker.switch', 'Switch branch: {{branch}}', {
              branch
            })}
            className="flex min-w-0 items-center gap-1 rounded-sm font-mono text-[10.5px] font-medium text-foreground outline-none focus-visible:ring-1 focus-visible:ring-ring"
          >
            <GitBranch className="size-3 shrink-0" />
            <span className="truncate">{branch}</span>
            <ChevronDown className="size-3 shrink-0" />
          </button>
        )}
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80">
        <Command shouldFilter={false}>
          <CommandInput
            placeholder={t('sourceControl.branchPicker.search', 'Search branches')}
            value={picker.query}
            onValueChange={picker.setQuery}
          />
          {[blocker, picker.error ?? picker.discoveryError].map(
            (reason) =>
              reason && (
                <p
                  key={reason}
                  role="status"
                  className="flex items-start gap-2 border-b bg-muted/50 px-3 py-2 text-xs text-muted-foreground"
                >
                  <Info className="mt-px size-3.5 shrink-0" />
                  {reason}
                </p>
              )
          )}
          <CommandList>
            {picker.rows.map((row) => (
              <BranchRow
                key={`${row.target.kind}:${row.target.name}`}
                row={row}
                branch={branch}
                openedAt={picker.openedAt}
                pending={picker.pending}
                disabled={row.target.kind === 'new' && dirtyOnlyBlocker ? picker.pending : disabled}
                onSelect={picker.select}
                onCopy={row.current ? onCopyBranch : undefined}
              />
            ))}
          </CommandList>
        </Command>
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
  onSelect,
  onCopy
}: {
  row: BranchPickerRow
  branch: string
  openedAt: number
  pending: boolean
  disabled: boolean
  onSelect: (row: BranchPickerRow) => Promise<void>
  onCopy?: () => void
}) {
  const t = useTranslate()
  const intlLocale = useIntlLocale()
  useUiLanguageRevision()
  return (
    <CommandItem
      value={`${row.target.kind}:${row.target.name}`}
      data-current={row.current ? 'true' : undefined}
      selection="palette"
      // A disabled item swallows pointer events, so a row carrying the copy button stays enabled; select ignores it.
      disabled={
        (row.current && !onCopy) ||
        (!row.current && (row.workspace ? pending : disabled || Boolean(row.occupiedPath)))
      }
      onSelect={() => void onSelect(row)}
    >
      <span className="min-w-0 flex-1 truncate">
        {row.target.kind === 'new'
          ? t('sourceControl.branchPicker.create', 'Create branch {{name}} from {{branch}}', {
              name: row.label,
              branch
            })
          : row.label}
      </span>
      {row.current ? (
        <>
          {onCopy && (
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              className="size-5"
              aria-label={t('sourceControl.branchPicker.copy', 'Copy branch name')}
              onClick={(event) => {
                // The row owns selection; copying must not reach it.
                event.stopPropagation()
                onCopy()
              }}
              onKeyDown={(event) => {
                // cmdk's root turns Enter into a select of the highlighted row.
                if (event.key === 'Enter' || event.key === ' ') {
                  event.stopPropagation()
                }
              }}
            >
              <Copy className="size-3" />
            </Button>
          )}
          <Check className="size-3" />
        </>
      ) : row.workspace ? (
        <span className="text-xs text-muted-foreground">
          {t('sourceControl.branchPicker.open', 'Open workspace')}
        </span>
      ) : row.occupiedPath ? (
        <span className="text-xs text-muted-foreground">
          {t('sourceControl.branchPicker.occupied', 'Checked out in {{path}}', {
            path: row.occupiedPath
          })}
        </span>
      ) : row.target.kind === 'remote' ? (
        <span className="text-xs text-muted-foreground">
          {t('sourceControl.branchPicker.remote', 'remote')}
        </span>
      ) : row.committedAt ? (
        <span className="text-xs text-muted-foreground">
          {formatUiRelativeTime(row.committedAt - openedAt, intlLocale)}
        </span>
      ) : null}
    </CommandItem>
  )
})
