import React from 'react'
import { translate } from '@/i18n/i18n'
import { getExecutionHostLabel } from '../../../../shared/execution-host'
import {
  WORKSPACE_CLEANUP_BLOCKER_MODE_VALUES,
  WORKSPACE_CLEANUP_BLOCKER_VALUES,
  WORKSPACE_CLEANUP_GIT_STATE_VALUES,
  WORKSPACE_CLEANUP_PRESENCE_VALUES,
  WORKSPACE_CLEANUP_REVIEW_STATE_VALUES,
  WORKSPACE_CLEANUP_TICKET_SOURCE_VALUES,
  WORKSPACE_CLEANUP_TRI_STATE_VALUES
} from '../../../../shared/workspace-cleanup-facet-rankings'
import { getWorkspaceCleanupBlockerLabel } from './workspace-cleanup-candidate-labels'
import {
  FacetChoice,
  FacetNumberField,
  FacetSection,
  FacetTextField,
  FacetToggleList
} from './workspace-cleanup-facet-controls'
import {
  getWorkspaceCleanupBlockerModeLabel,
  getWorkspaceCleanupGitStateLabel,
  getWorkspaceCleanupPresenceLabel,
  getWorkspaceCleanupReviewProviderLabel,
  getWorkspaceCleanupReviewStateLabel,
  getWorkspaceCleanupTicketSourceLabel,
  getWorkspaceCleanupTriStateLabel
} from './workspace-cleanup-facet-labels'
import type { WorkspaceCleanupFacetGroupProps } from './workspace-cleanup-facet-panel-model'

/** Git, review/PR, tickets, location/host, and safety blockers. */
export function WorkspaceCleanupGitReviewFacets({
  filters,
  counts,
  totalCount,
  options,
  onPatch
}: WorkspaceCleanupFacetGroupProps): React.JSX.Element {
  return (
    <>
      <FacetSection
        title={translate('components.workspace.cleanup.browse.facet.git', 'Git')}
        matchCount={counts.git}
        totalCount={totalCount}
      >
        <FacetToggleList
          values={WORKSPACE_CLEANUP_GIT_STATE_VALUES}
          selected={filters.git.states}
          getLabel={getWorkspaceCleanupGitStateLabel}
          onChange={(states) => onPatch('git', { states })}
        />
        <FacetNumberField
          label={translate('components.workspace.cleanup.browse.minAhead', 'Commits ahead ≥')}
          value={filters.git.minAhead}
          onChange={(minAhead) => onPatch('git', { minAhead })}
        />
        <FacetNumberField
          label={translate('components.workspace.cleanup.browse.minBehind', 'Commits behind ≥')}
          value={filters.git.minBehind}
          onChange={(minBehind) => onPatch('git', { minBehind })}
        />
        <FacetTextField
          label={translate('components.workspace.cleanup.browse.branchQuery', 'Branch contains')}
          value={filters.git.branchQuery}
          onChange={(branchQuery) => onPatch('git', { branchQuery })}
        />
        <FacetChoice
          label={translate('components.workspace.cleanup.browse.prunable', 'Prunable')}
          value={filters.git.prunable}
          options={WORKSPACE_CLEANUP_TRI_STATE_VALUES}
          getLabel={getWorkspaceCleanupTriStateLabel}
          onChange={(prunable) => onPatch('git', { prunable })}
        />
        <FacetChoice
          label={translate('components.workspace.cleanup.browse.locked', 'Locked')}
          value={filters.git.locked}
          options={WORKSPACE_CLEANUP_TRI_STATE_VALUES}
          getLabel={getWorkspaceCleanupTriStateLabel}
          onChange={(locked) => onPatch('git', { locked })}
        />
      </FacetSection>

      <FacetSection
        title={translate('components.workspace.cleanup.browse.facet.review', 'Review')}
        matchCount={counts.review}
        totalCount={totalCount}
      >
        <FacetChoice
          label={translate('components.workspace.cleanup.browse.reviewPresence', 'PR / MR')}
          value={filters.review.presence}
          options={WORKSPACE_CLEANUP_PRESENCE_VALUES}
          getLabel={getWorkspaceCleanupPresenceLabel}
          onChange={(presence) => onPatch('review', { presence })}
        />
        <FacetToggleList
          values={WORKSPACE_CLEANUP_REVIEW_STATE_VALUES}
          selected={filters.review.states}
          getLabel={getWorkspaceCleanupReviewStateLabel}
          onChange={(states) => onPatch('review', { states })}
        />
        {options.reviewProviders.length > 0 ? (
          <FacetToggleList
            label={translate('components.workspace.cleanup.browse.reviewProvider', 'Provider')}
            values={options.reviewProviders}
            selected={filters.review.providers}
            getLabel={getWorkspaceCleanupReviewProviderLabel}
            onChange={(providers) => onPatch('review', { providers })}
          />
        ) : null}
      </FacetSection>

      <FacetSection
        title={translate('components.workspace.cleanup.browse.facet.ticket', 'Tickets')}
        matchCount={counts.ticket}
        totalCount={totalCount}
      >
        <FacetChoice
          label={translate('components.workspace.cleanup.browse.ticketPresence', 'Linked ticket')}
          value={filters.ticket.presence}
          options={WORKSPACE_CLEANUP_PRESENCE_VALUES}
          getLabel={getWorkspaceCleanupPresenceLabel}
          onChange={(presence) => onPatch('ticket', { presence })}
        />
        <FacetToggleList
          values={WORKSPACE_CLEANUP_TICKET_SOURCE_VALUES}
          selected={filters.ticket.sources}
          getLabel={getWorkspaceCleanupTicketSourceLabel}
          onChange={(sources) => onPatch('ticket', { sources })}
        />
      </FacetSection>

      <FacetSection
        title={translate('components.workspace.cleanup.browse.facet.location', 'Location')}
        matchCount={counts.location}
        totalCount={totalCount}
      >
        <FacetToggleList
          label={translate('components.workspace.cleanup.browse.host', 'Host')}
          values={options.hostIds}
          selected={filters.location.hostIds}
          getLabel={getExecutionHostLabel}
          onChange={(hostIds) => onPatch('location', { hostIds })}
        />
        {options.repos.length > 1 ? (
          <FacetToggleList
            label={translate('components.workspace.cleanup.browse.repo', 'Repository')}
            values={options.repos.map((repo) => repo.id)}
            selected={filters.location.repoIds}
            getLabel={(id) => options.repos.find((repo) => repo.id === id)?.label ?? id}
            onChange={(repoIds) => onPatch('location', { repoIds })}
          />
        ) : null}
        <FacetTextField
          label={translate('components.workspace.cleanup.browse.pathPrefix', 'Path starts with')}
          value={filters.location.pathPrefix}
          onChange={(pathPrefix) => onPatch('location', { pathPrefix })}
        />
      </FacetSection>

      <FacetSection
        title={translate('components.workspace.cleanup.browse.facet.safety', 'Safety')}
        matchCount={counts.safety}
        totalCount={totalCount}
      >
        <FacetChoice
          label={translate('components.workspace.cleanup.browse.blockerMode', 'Blocker match')}
          value={filters.safety.blockerMode}
          options={WORKSPACE_CLEANUP_BLOCKER_MODE_VALUES}
          getLabel={getWorkspaceCleanupBlockerModeLabel}
          onChange={(blockerMode) => onPatch('safety', { blockerMode })}
        />
        <FacetToggleList
          label={translate('components.workspace.cleanup.browse.blockers', 'Blockers')}
          values={WORKSPACE_CLEANUP_BLOCKER_VALUES}
          selected={filters.safety.blockers}
          getLabel={getWorkspaceCleanupBlockerLabel}
          onChange={(blockers) => onPatch('safety', { blockers })}
        />
        <FacetChoice
          label={translate('components.workspace.cleanup.browse.dismissed', 'Ignored')}
          value={filters.safety.dismissed}
          options={WORKSPACE_CLEANUP_TRI_STATE_VALUES}
          getLabel={getWorkspaceCleanupTriStateLabel}
          onChange={(dismissed) => onPatch('safety', { dismissed })}
        />
      </FacetSection>
    </>
  )
}
