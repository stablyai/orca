import { Check, Search, Trash2 } from 'lucide-react'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select'
import { formatBytes } from './workspace-space-format'
import { translate } from '@/i18n/i18n'
import type { WorkspaceSpaceSortKey } from './workspace-space-presentation'
import type { useWorkspaceSpaceManagerPanel } from './use-workspace-space-manager-panel'

type WorkspaceSpaceManagerModel = ReturnType<typeof useWorkspaceSpaceManagerPanel>

export function WorkspaceSpaceManagerToolbar({
  model
}: {
  model: WorkspaceSpaceManagerModel
}): React.JSX.Element {
  const {
    allVisibleSelected,
    deleteSelected,
    hasRows,
    onlyDeletable,
    query,
    selectedDeletableIds,
    selectedReclaimableBytes,
    selectSortKey,
    setOnlyDeletable,
    setQuery,
    setSelectedIds,
    sortKey,
    toggleVisibleSelection,
    visibleDeletableIds
  } = model
  return (
    <>
      {hasRows ? (
        <div className="sticky top-0 z-10 -mx-1 flex flex-wrap items-center justify-between gap-2 rounded-md border border-border/70 bg-background/95 px-3 py-2 shadow-xs backdrop-blur">
          <div className="min-w-0 text-xs text-muted-foreground">
            <span className="font-medium text-foreground">
              {selectedDeletableIds.length}{' '}
              {translate(
                'auto.components.status.bar.WorkspaceSpaceManagerPanel.65402b7192',
                'selected'
              )}
            </span>
            <span className="mx-1.5">·</span>
            <span>
              {formatBytes(selectedReclaimableBytes)}{' '}
              {translate(
                'auto.components.status.bar.WorkspaceSpaceManagerPanel.0cb1501ccf',
                'reclaimable'
              )}
            </span>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setSelectedIds(new Set<string>())}
              disabled={selectedDeletableIds.length === 0}
              className="!px-3"
            >
              {translate(
                'auto.components.status.bar.WorkspaceSpaceManagerPanel.e4a12c455b',
                'Clear'
              )}
            </Button>
            <Button
              variant="destructive"
              size="sm"
              onClick={deleteSelected}
              disabled={selectedDeletableIds.length === 0}
              className="min-w-[9.5rem] gap-1.5 !px-3.5"
            >
              <Trash2 className="size-3.5" />
              {translate(
                'auto.components.status.bar.WorkspaceSpaceManagerPanel.5caccea440',
                'Delete selected'
              )}
            </Button>
          </div>
        </div>
      ) : null}

      {hasRows ? (
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-[16rem] flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={translate(
                'auto.components.status.bar.WorkspaceSpaceManagerPanel.6f8f6a6b04',
                'Filter workspaces'
              )}
              className="pl-9"
            />
          </div>

          <Select
            value={sortKey}
            onValueChange={(value) => selectSortKey(value as WorkspaceSpaceSortKey)}
          >
            <SelectTrigger className="w-36">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="size">
                {translate(
                  'auto.components.status.bar.WorkspaceSpaceManagerPanel.33aef3e9cc',
                  'Size'
                )}
              </SelectItem>
              <SelectItem value="name">
                {translate(
                  'auto.components.status.bar.WorkspaceSpaceManagerPanel.243287ac60',
                  'Name'
                )}
              </SelectItem>
              <SelectItem value="repo">
                {translate(
                  'auto.components.status.bar.WorkspaceSpaceManagerPanel.81f14d9924',
                  'Repository'
                )}
              </SelectItem>
              <SelectItem value="activity">
                {translate(
                  'auto.components.status.bar.WorkspaceSpaceManagerPanel.d7ac56452e',
                  'Activity'
                )}
              </SelectItem>
            </SelectContent>
          </Select>

          <Button
            variant={onlyDeletable ? 'secondary' : 'outline'}
            size="sm"
            onClick={() => setOnlyDeletable((current) => !current)}
            className="w-32"
            aria-label={translate(
              'auto.components.status.bar.WorkspaceSpaceManagerPanel.81aaf1de65',
              'Show only deletable workspaces'
            )}
          >
            {onlyDeletable
              ? translate(
                  'auto.components.status.bar.WorkspaceSpaceManagerPanel.b2f82ed5ae',
                  'Deletable'
                )
              : translate(
                  'auto.components.status.bar.WorkspaceSpaceManagerPanel.ef890d31b9',
                  'All'
                )}
          </Button>

          <Button
            variant="outline"
            size="sm"
            onClick={toggleVisibleSelection}
            disabled={visibleDeletableIds.length === 0}
            className="w-32 gap-1.5"
            aria-label={
              allVisibleSelected
                ? translate(
                    'auto.components.status.bar.WorkspaceSpaceManagerPanel.697d60c456',
                    'Clear visible selection'
                  )
                : translate(
                    'auto.components.status.bar.WorkspaceSpaceManagerPanel.1d0f8300d1',
                    'Select visible deletable workspaces'
                  )
            }
          >
            <Check className="size-3.5" />
            {allVisibleSelected
              ? translate(
                  'auto.components.status.bar.WorkspaceSpaceManagerPanel.e4a12c455b',
                  'Clear'
                )
              : translate(
                  'auto.components.status.bar.WorkspaceSpaceManagerPanel.f39d291997',
                  'Select'
                )}
          </Button>
        </div>
      ) : null}
    </>
  )
}
