import React from 'react'
import { formatActiveFilterBadge } from '../../../../shared/workspace-view/workspace-row-filters'

/** Active-filter count on a sidebar options trigger (the trigger must be `relative`). Shared so
 *  the workspace and activity headers signal filtering identically. */
export function OptionsFilterCountBadge({ count }: { count: number }): React.JSX.Element | null {
  if (count === 0) {
    return null
  }
  return (
    <span
      aria-hidden
      data-options-filter-count=""
      className="absolute -top-0.5 -right-0.5 flex h-3 min-w-3 items-center justify-center rounded-full bg-primary px-0.5 text-[9px] font-medium leading-none text-primary-foreground"
    >
      {formatActiveFilterBadge(count)}
    </span>
  )
}
