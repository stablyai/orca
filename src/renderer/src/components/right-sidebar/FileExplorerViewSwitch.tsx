import React from 'react'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import type { RightSidebarExplorerView } from '../../../../shared/types'

type FileExplorerViewSwitchProps = {
  view: RightSidebarExplorerView
  onSelectView: (view: RightSidebarExplorerView) => void
}

type ExplorerViewOption = {
  view: RightSidebarExplorerView
  label: string
  ariaLabel: string
}

export function FileExplorerViewSwitch({
  view,
  onSelectView
}: FileExplorerViewSwitchProps): React.JSX.Element {
  const options: ExplorerViewOption[] = [
    {
      view: 'files',
      label: translate('auto.components.right.sidebar.FileExplorerViewSwitch.c4e9a2b713', 'Names'),
      ariaLabel: translate(
        'auto.components.right.sidebar.FileExplorerViewSwitch.b3c8f1a902',
        'Filter files by name'
      )
    },
    {
      view: 'search',
      label: translate(
        'auto.components.right.sidebar.FileExplorerNameFilter.7a9fb1e6aa',
        'Contents'
      ),
      ariaLabel: translate(
        'auto.components.right.sidebar.FileExplorerToolbar.c1f3f3ec70',
        'Search file contents'
      )
    }
  ]

  return (
    <div
      role="tablist"
      aria-label={translate(
        'auto.components.right.sidebar.FileExplorerViewSwitch.f8a2c4d1e0',
        'Explorer search mode'
      )}
      className="flex h-7 w-full items-center gap-0.5 rounded-md bg-input/40 p-0.5"
      data-ignore-file-explorer-keys="true"
    >
      {options.map((option) => {
        const selected = view === option.view
        return (
          <button
            key={option.view}
            type="button"
            role="tab"
            aria-selected={selected}
            aria-label={option.ariaLabel}
            className={cn(
              'h-full min-w-0 flex-1 rounded-sm px-2 text-[11px] transition-[color,background-color,box-shadow] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
              selected
                ? 'bg-background font-medium text-foreground shadow-xs'
                : 'text-muted-foreground hover:bg-background/40 hover:text-foreground'
            )}
            onClick={() => onSelectView(option.view)}
          >
            {option.label}
          </button>
        )
      })}
    </div>
  )
}
