import React from 'react'
import { translate } from '@/i18n/i18n'
import type { WorkspaceCleanupCandidate } from '../../../../shared/workspace-cleanup'
import { formatBytes } from '../status-bar/workspace-space-format'
import { CandidateRow, type WorkspaceCleanupDeletionPhase } from './workspace-cleanup-candidate-row'
import { WorkspaceCleanupCandidateList } from './workspace-cleanup-candidate-list'
import { WorkspaceCleanupEmptyState } from './workspace-cleanup-dialog-notices'
import type { WorkspaceCleanupFacets } from './workspace-cleanup-facets'
import { formatWorkspaceCleanupRelativeTime } from './workspace-cleanup-relative-time'
import type { WorkspaceCleanupFailure } from '@/store/slices/workspace-cleanup'

export type WorkspaceCleanupRowListState = {
  rows: readonly WorkspaceCleanupFacets[]
  /** The dialog's "as of" clock; keeps row labels consistent with filter bucketing. */
  now: number
  /** Rows the scan produced before filtering; separates "empty fleet" from "no matches". */
  scannedCount: number
  hasScanned: boolean
  loading: boolean
  deletionPhaseByIdentity: Record<string, WorkspaceCleanupDeletionPhase>
  deletingIdentities: ReadonlySet<string>
  /** Host-qualified identities (see WorkspaceCleanupFacets.identity). */
  expandedRowIds: ReadonlySet<string>
  selectedIds: ReadonlySet<string>
  gitPendingWorktreeIds: ReadonlySet<string>
  /** Keyed by host-qualified identity so a failure marks only its own host's row. */
  rowFailures: Record<string, WorkspaceCleanupFailure>
  scrollElement: HTMLDivElement | null
  onClearFilters: () => void
  onToggleExpanded: (identity: string) => void
  onToggleSelected: (identity: string) => void
  onView: (candidate: WorkspaceCleanupCandidate) => void
  onIgnore: (candidate: WorkspaceCleanupCandidate) => void
  onRemove: (candidate: WorkspaceCleanupCandidate) => void
  onForgetLocally: (candidate: WorkspaceCleanupCandidate) => void
  onDeleteAnyway: (candidate: WorkspaceCleanupCandidate) => void
}

export function WorkspaceCleanupRowList(props: WorkspaceCleanupRowListState): React.JSX.Element {
  const { rows, loading, hasScanned, scannedCount } = props
  const settled = !loading && hasScanned
  return (
    <>
      {settled && scannedCount === 0 ? (
        <WorkspaceCleanupEmptyState
          title={translate(
            'components.workspace.cleanup.browse.noWorkspaces',
            'No workspaces found.'
          )}
        />
      ) : null}
      {hasScanned && scannedCount > 0 && rows.length === 0 ? (
        <WorkspaceCleanupEmptyState
          title={translate(
            'components.workspace.cleanup.browse.noMatches',
            'No workspaces match these filters.'
          )}
          description={translate(
            'components.workspace.cleanup.browse.noMatchesDescription',
            'Every workspace is in one list — widen a facet or clear the filters.'
          )}
          actionLabel={translate(
            'components.workspace.cleanup.browse.clearFilters',
            'Clear filters'
          )}
          onAction={props.onClearFilters}
        />
      ) : null}
      <WorkspaceCleanupCandidateList
        rows={rows}
        getRowKey={(row) => row.identity}
        scrollElement={props.scrollElement}
        renderRow={(row, index) => (
          <CandidateRow
            key={row.identity}
            identity={row.identity}
            candidate={row.candidate}
            reviewInfo={row.review}
            last={rows.length > 1 && index === rows.length - 1}
            expanded={props.expandedRowIds.has(row.identity)}
            lastActivityLabel={formatWorkspaceCleanupRelativeTime(row.lastActivityAt, props.now)}
            sizeLabel={row.sizeBytes === null ? null : formatBytes(row.sizeBytes)}
            workspaceStatusLabel={row.workspaceStatusLabel}
            gitEvidencePending={props.gitPendingWorktreeIds.has(row.worktreeId)}
            deletionPhase={props.deletionPhaseByIdentity[row.identity]}
            // Why: a background rescan must not lock rows; only an actual
            // removal batch or this row's own deletion disables it.
            removing={props.deletingIdentities.has(row.identity)}
            selected={
              props.selectedIds.has(row.identity) && !props.deletingIdentities.has(row.identity)
            }
            failure={props.rowFailures[row.identity]}
            onToggleExpanded={props.onToggleExpanded}
            onToggleSelected={props.onToggleSelected}
            onView={props.onView}
            onIgnore={props.onIgnore}
            onRemove={props.onRemove}
            onForgetLocally={props.onForgetLocally}
            onDeleteAnyway={props.onDeleteAnyway}
          />
        )}
      />
    </>
  )
}
