import type React from 'react'
import { translate } from '@/i18n/i18n'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import type { RightSidebarExplorerView } from '../../../../shared/ui-chrome-types'

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
    <div className="rounded-md bg-muted p-0.5">
      <ToggleGroup
        variant="segmented"
        size="xs"
        type="single"
        spacing={1}
        value={view}
        onValueChange={(value) => {
          if (value === 'files' || value === 'search') {
            onSelectView(value)
          }
        }}
        aria-label={translate(
          'auto.components.right.sidebar.FileExplorerViewSwitch.f8a2c4d1e0',
          'Explorer search mode'
        )}
        className="h-6 w-full"
        data-ignore-file-explorer-keys="true"
      >
        {options.map((option) => (
          <ToggleGroupItem
            key={option.view}
            value={option.view}
            aria-label={option.ariaLabel}
            className="min-w-0 flex-1"
          >
            {option.label}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
    </div>
  )
}
