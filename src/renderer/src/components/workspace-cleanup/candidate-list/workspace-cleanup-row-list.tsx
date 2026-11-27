import React, { useMemo } from 'react'
import { useAppStore } from '@/store'
import { useTranslate } from '@/i18n/use-translate'
import type { WorkspaceCleanupCandidate } from '../../../../../shared/workspace-cleanup/workspace-cleanup'
import { formatBytes } from '../../../../../shared/text/format-bytes'
import { CandidateRow, type WorkspaceCleanupDeletionPhase } from './workspace-cleanup-candidate-row'
import { WorkspaceCleanupCandidateList } from './workspace-cleanup-candidate-list'
import { WorkspaceCleanupEmptyState } from '../dialog/workspace-cleanup-dialog-notices'
import type { WorkspaceCleanupFacets } from '../query/workspace-cleanup-facets'
import { formatWorkspaceCleanupRelativeTime } from './workspace-cleanup-relative-time'
import type { WorkspaceCleanupFailure } from '@/store/slices/workspace-cleanup/workspace-cleanup-removal'
import {
  findWorkspaceCleanupCandidateRepo,
  groupWorkspaceCleanupReposById
} from '../candidate-evidence/workspace-cleanup-review-lookup'
import type { WorkspaceCleanupGroup } from '../../../../../shared/workspace-cleanup/workspace-cleanup-groups'

export type WorkspaceCleanupRowListState = {
  rows: readonly WorkspaceCleanupFacets[]
  /** The dialog's "as of" clock; keeps row labels consistent with filter bucketing. */
  now: number
  /** Rows the scan produced before filtering; separates "empty fleet" from "no matches". */
  scannedCandidates: readonly WorkspaceCleanupCandidate[]
  /** Search or filters are narrowing the list, which changes why a group can be empty. */
  hasActiveFilters: boolean
  getRowGroup: (row: WorkspaceCleanupFacets) => WorkspaceCleanupGroup
  hasScanned: boolean
  loading: boolean
  deletionPhaseByIdentity: Record<string, WorkspaceCleanupDeletionPhase>
  deletingIdentities: ReadonlySet<string>
  /** Host-qualified identities (see WorkspaceCleanupFacets.identity). */
  expandedRowIds: ReadonlySet<string>
  selectedIds: ReadonlySet<string>
  /** Keyed by host-qualified identity so a failure marks only its own host's row. */
  rowFailures: Record<string, WorkspaceCleanupFailure>
  scrollElement: HTMLDivElement | null
  onClearFilters: () => void
  onToggleExpanded: (identity: string) => void
  onToggleSelected: (identity: string) => void
  onView: (candidate: WorkspaceCleanupCandidate) => void
  onIgnore: (candidate: WorkspaceCleanupCandidate) => void
  onRestore: (candidate: WorkspaceCleanupCandidate) => void
  onRemove: (candidate: WorkspaceCleanupCandidate) => void
  onForgetLocally: (candidate: WorkspaceCleanupCandidate) => void
  onDeleteAnyway: (candidate: WorkspaceCleanupCandidate) => void
}

export function WorkspaceCleanupRowList(props: WorkspaceCleanupRowListState): React.JSX.Element {
  const t = useTranslate()
  const { rows, loading, hasScanned, scannedCandidates } = props
  const scannedCount = scannedCandidates.length
  const settled = !loading && hasScanned
  const repos = useAppStore((s) => s.repos)
  const reposById = useMemo(() => groupWorkspaceCleanupReposById(repos), [repos])
  return (
    <>
      {settled && scannedCount === 0 ? (
        <WorkspaceCleanupEmptyState
          title={t('components.workspace.cleanup.browse.noWorkspaces', 'No workspaces found.')}
        />
      ) : null}
      {settled && scannedCount > 0 && rows.length === 0 ? (
        props.hasActiveFilters ? (
          <WorkspaceCleanupEmptyState
            title={t(
              'components.workspace.cleanup.browse.noMatches',
              'No workspaces match these filters.'
            )}
            description={t(
              'components.workspace.cleanup.browse.noMatchesDescription',
              'Every workspace is in one list — widen a facet or clear the filters.'
            )}
            actionLabel={t('components.workspace.cleanup.browse.clearFilters', 'Clear filters')}
            onAction={props.onClearFilters}
          />
        ) : (
          <WorkspaceCleanupEmptyState
            title={t('components.workspace.cleanup.group.empty', 'No workspaces here.')}
          />
        )
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
            repo={findWorkspaceCleanupCandidateRepo(row.candidate, reposById)}
            group={props.getRowGroup(row)}
            last={rows.length > 1 && index === rows.length - 1}
            expanded={props.expandedRowIds.has(row.identity)}
            lastActivityLabel={formatWorkspaceCleanupRelativeTime(row.lastActivityAt, props.now)}
            sizeLabel={row.sizeBytes === null ? null : formatBytes(row.sizeBytes)}
            workspaceStatusLabel={row.workspaceStatusLabel}
            deletionPhase={props.deletionPhaseByIdentity[row.identity]}
            // Background scans leave rows interactive; only batch removal or the row’s own delete disables them.
            removing={props.deletingIdentities.has(row.identity)}
            selected={
              props.selectedIds.has(row.identity) && !props.deletingIdentities.has(row.identity)
            }
            failure={props.rowFailures[row.identity]}
            onToggleExpanded={props.onToggleExpanded}
            onToggleSelected={props.onToggleSelected}
            onView={props.onView}
            onIgnore={props.onIgnore}
            onRestore={props.onRestore}
            onRemove={props.onRemove}
            onForgetLocally={props.onForgetLocally}
            onDeleteAnyway={props.onDeleteAnyway}
          />
        )}
      />
    </>
  )
}
