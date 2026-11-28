import { defineFixture } from '../../../component-fixtures/component-fixture'
import { Dialog } from '@/components/ui/dialog'
import {
  createDefaultWorkspaceCleanupFilterState,
  DEFAULT_WORKSPACE_CLEANUP_SORT
} from '../../../../../shared/workspace-cleanup/workspace-cleanup-filter-model'
import { WorkspaceCleanupDialogHeader } from './workspace-cleanup-dialog-header'
import { WorkspaceCleanupFilterBar } from '../browse/workspace-cleanup-filter-bar'
import type { WorkspaceCleanupFacetCounts } from '../browse/workspace-cleanup-facet-panel-model'
import { WorkspaceCleanupGroupCards } from './workspace-cleanup-group-cards'
import { WorkspaceCleanupSelectAllBar } from './workspace-cleanup-select-all-bar'
import { WorkspaceCleanupPickFooter } from './workspace-cleanup-pick-footer'

const COUNTS: WorkspaceCleanupFacetCounts = {
  activity: 0,
  size: 0,
  status: 0,
  agent: 0,
  git: 0,
  review: 0,
  ticket: 0,
  context: 0,
  location: 0,
  safety: 0
}
const noop = (): void => {}
function Top({
  selected = 0,
  scanning = false,
  sizes = true,
  query = '',
  refreshing = false
}: {
  selected?: number
  scanning?: boolean
  sizes?: boolean
  query?: string
  refreshing?: boolean
}): React.JSX.Element {
  const filters = { ...createDefaultWorkspaceCleanupFilterState(), query }
  return (
    // The title needs a Dialog context; the root alone renders no overlay.
    <Dialog>
      <div className="flex flex-col border border-border bg-background">
        <WorkspaceCleanupDialogHeader
          title="Review workspaces"
          loading={refreshing}
          onRefresh={noop}
          onClose={noop}
        />
        <WorkspaceCleanupFilterBar
          facetProps={{
            filters,
            counts: COUNTS,
            totalCount: 5,
            options: { workspaceStatuses: [], hostIds: [], repos: [], reviewProviders: [] },
            onPatch: noop
          }}
          facetPanelOpen={false}
          onFacetPanelOpenChange={noop}
          matchedCount={query ? 2 : 5}
          hasActiveFilters={query.length > 0}
          gitEvidence={{ pendingCount: refreshing ? 4 : 0, totalCount: 5 }}
          sizeScan={sizes ? { scanning, scannedCount: 2, totalCount: 5, onRun: noop } : null}
          sort={DEFAULT_WORKSPACE_CLEANUP_SORT}
          onToggleSortField={noop}
          onQueryChange={noop}
          onClearFilters={noop}
          onClearAppliedFilter={noop}
        />
        <WorkspaceCleanupGroupCards
          active="nothing-local"
          summaries={{
            'nothing-local': { count: 46, selectedCount: selected },
            'local-files': { count: 35, selectedCount: 0 },
            'cannot-delete': { count: 3, selectedCount: 0 }
          }}
          onChange={noop}
        />
        <WorkspaceCleanupSelectAllBar
          selectableCount={46}
          selectedBulkCount={selected}
          selectedDisplayedCount={selected}
          onToggle={noop}
        />
        <WorkspaceCleanupPickFooter
          selectedCount={selected}
          deleteBlocked={false}
          onDelete={noop}
        />
      </div>
    </Dialog>
  )
}

export const idle = defineFixture({ width: 900, render: () => <Top /> })

export const selected = defineFixture({ width: 900, render: () => <Top selected={2} /> })

export const scanningSizes = defineFixture({
  width: 900,
  render: () => <Top scanning query="orca" />
})

export const sizesMeasured = defineFixture({ width: 900, render: () => <Top sizes={false} /> })

export const narrow = defineFixture({ width: 560, render: () => <Top selected={1} /> })

export const refreshing = defineFixture({ width: 900, render: () => <Top refreshing /> })
