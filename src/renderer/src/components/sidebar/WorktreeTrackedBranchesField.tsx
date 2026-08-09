import React from 'react'
import { Input } from '@/components/ui/input'
import { translate } from '@/i18n/i18n'

type WorktreeTrackedBranchesFieldProps = {
  value: string
  onValueChange: (next: string) => void
  onKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => void
}

/** Comma-separated sibling branches whose reviews the worktree card surfaces. */
export function WorktreeTrackedBranchesField({
  value,
  onValueChange,
  onKeyDown
}: WorktreeTrackedBranchesFieldProps): React.JSX.Element {
  return (
    <div className="space-y-1">
      <label className="text-[11px] font-medium text-muted-foreground">
        {translate(
          'auto.components.sidebar.WorktreeMetaDialog.trackedBranchesLabel',
          'Tracked Branches'
        )}
      </label>
      <Input
        value={value}
        onChange={(e) => onValueChange(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder={translate(
          'auto.components.sidebar.WorktreeMetaDialog.trackedBranchesPlaceholder',
          'task/x-v1.15.0, task/x-stage'
        )}
        className="h-8 text-xs"
      />
      <p className="text-[10px] text-muted-foreground">
        {translate(
          'auto.components.sidebar.WorktreeMetaDialog.trackedBranchesHelp',
          'Comma-separated sibling branches whose pull requests also show on this card. Leave blank to track none.'
        )}
      </p>
    </div>
  )
}
