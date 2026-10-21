import React from 'react'
import { Archive, ChevronDown, ChevronRight } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'

/** The one muted row archived machines fold into; opening it lists their host sections below. */
export function ArchivedMachinesRow({
  count,
  expanded
}: {
  count: number
  expanded: boolean
}): React.JSX.Element {
  const setExpanded = useAppStore((state) => state.setArchivedMachinesExpanded)
  const Chevron = expanded ? ChevronDown : ChevronRight
  return (
    <div className="px-2 pt-1">
      <button
        type="button"
        aria-expanded={expanded}
        data-archived-machines=""
        onClick={() => setExpanded(!expanded)}
        className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-xs text-muted-foreground hover:bg-worktree-sidebar-accent/50"
      >
        <Archive className="size-3.5 shrink-0" />
        <span className="min-w-0 flex-1 truncate">
          {translate(
            'auto.components.sidebar.ArchivedMachinesRow.label',
            'Archived machines ({{count}})',
            { count }
          )}
        </span>
        <Chevron className="size-3.5 shrink-0" />
      </button>
    </div>
  )
}
