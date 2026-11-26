import React, { useId } from 'react'
import { Checkbox } from '@/components/ui/checkbox'
import { useTranslate } from '@/i18n/use-translate'

/** Select-all for the open card: mixed while some of its rows are ticked. */
export function WorkspaceCleanupSelectAllBar({
  selectableCount,
  selectedBulkCount,
  selectedDisplayedCount,
  onToggle
}: {
  /** Rows select-all can add in the open card. */
  selectableCount: number
  /** Ticked rows among those. */
  selectedBulkCount: number
  /** Every ticked row shown in the open card, including ones select-all would skip. */
  selectedDisplayedCount: number
  onToggle: (selectAll: boolean) => void
}): React.JSX.Element {
  const t = useTranslate()
  const id = useId()
  const allSelected = selectableCount > 0 && selectedBulkCount >= selectableCount
  const anyChecked = selectedDisplayedCount > 0
  const mixed = anyChecked && !allSelected
  const label =
    selectedBulkCount > 0
      ? t('components.workspace.cleanup.selectAll.partial', '{{selected}} of {{total}} selected', {
          selected: selectedBulkCount,
          total: selectableCount
        })
      : t('components.workspace.cleanup.selectAll.all', 'Select all {{count}}', {
          count: selectableCount
        })
  return (
    <div className="flex h-10 items-center gap-2.5 border-b border-border bg-muted/25 px-4">
      <Checkbox
        id={id}
        checked={mixed ? 'indeterminate' : allSelected}
        disabled={selectableCount === 0 && !anyChecked}
        // A checked or mixed box clears what is ticked here; an empty one selects all.
        onCheckedChange={() => onToggle(!anyChecked)}
      />
      <label htmlFor={id} className="min-w-0 flex-1 truncate text-xs font-medium">
        {label}
      </label>
    </div>
  )
}
