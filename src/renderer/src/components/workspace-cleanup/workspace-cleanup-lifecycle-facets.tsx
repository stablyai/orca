import React from 'react'
import { translate } from '@/i18n/i18n'
import {
  WORKSPACE_CLEANUP_AGENT_STATE_VALUES,
  WORKSPACE_CLEANUP_IDLE_SIGNAL_VALUES,
  WORKSPACE_CLEANUP_PRESENCE_VALUES,
  WORKSPACE_CLEANUP_TRI_STATE_VALUES
} from '../../../../shared/workspace-cleanup-facet-rankings'
import {
  FacetCheckbox,
  FacetChoice,
  FacetNumberField,
  FacetSection,
  FacetToggleList
} from './workspace-cleanup-facet-controls'
import {
  getWorkspaceCleanupAgentStateLabel,
  getWorkspaceCleanupIdleSignalLabel,
  getWorkspaceCleanupPresenceLabel,
  getWorkspaceCleanupTriStateLabel
} from './workspace-cleanup-facet-labels'
import {
  fromMegabytes,
  toMegabytes,
  type WorkspaceCleanupFacetGroupProps
} from './workspace-cleanup-facet-panel-model'

/** Activity, size, workspace status, agent state, and local context. */
export function WorkspaceCleanupLifecycleFacets({
  filters,
  counts,
  totalCount,
  options,
  onPatch
}: WorkspaceCleanupFacetGroupProps): React.JSX.Element {
  return (
    <>
      <FacetSection
        title={translate('components.workspace.cleanup.browse.facet.activity', 'Activity')}
        matchCount={counts.activity}
        totalCount={totalCount}
      >
        <FacetChoice
          label={translate('components.workspace.cleanup.browse.idleSignalField', 'Idle signal')}
          value={filters.activity.idleSignal}
          options={WORKSPACE_CLEANUP_IDLE_SIGNAL_VALUES}
          getLabel={getWorkspaceCleanupIdleSignalLabel}
          onChange={(idleSignal) => onPatch('activity', { idleSignal })}
        />
        <FacetNumberField
          label={translate('components.workspace.cleanup.browse.idleMinDays', 'Idle for at least')}
          value={filters.activity.idleMinDays}
          placeholder="30"
          suffix={translate('components.workspace.cleanup.browse.days', 'days')}
          onChange={(idleMinDays) => onPatch('activity', { idleMinDays })}
        />
        <FacetCheckbox
          id="activity-never-visited"
          label={translate('components.workspace.cleanup.browse.neverVisited', 'Never opened')}
          checked={filters.activity.neverVisited}
          onChange={(neverVisited) => onPatch('activity', { neverVisited })}
        />
      </FacetSection>

      <FacetSection
        title={translate('components.workspace.cleanup.browse.facet.size', 'Size on disk')}
        matchCount={counts.size}
        totalCount={totalCount}
      >
        <FacetNumberField
          label={translate('components.workspace.cleanup.browse.minSize', 'At least')}
          value={toMegabytes(filters.size.minBytes)}
          placeholder="0"
          suffix="MB"
          onChange={(megabytes) => onPatch('size', { minBytes: fromMegabytes(megabytes) })}
        />
        <FacetNumberField
          label={translate('components.workspace.cleanup.browse.maxSize', 'At most')}
          value={toMegabytes(filters.size.maxBytes)}
          suffix="MB"
          onChange={(megabytes) => onPatch('size', { maxBytes: fromMegabytes(megabytes) })}
        />
        <FacetCheckbox
          id="size-include-unsized"
          label={translate(
            'components.workspace.cleanup.browse.includeUnsized',
            'Include unmeasured workspaces'
          )}
          checked={filters.size.includeUnsized}
          onChange={(includeUnsized) => onPatch('size', { includeUnsized })}
        />
      </FacetSection>

      <FacetSection
        title={translate('components.workspace.cleanup.browse.facet.status', 'Workspace status')}
        matchCount={counts.status}
        totalCount={totalCount}
      >
        {options.workspaceStatuses.length > 0 ? (
          <FacetToggleList
            values={options.workspaceStatuses.map((status) => status.id)}
            selected={filters.status.workspaceStatuses}
            getLabel={(id) =>
              options.workspaceStatuses.find((status) => status.id === id)?.label ?? id
            }
            onChange={(workspaceStatuses) => onPatch('status', { workspaceStatuses })}
          />
        ) : null}
        <FacetCheckbox
          id="status-match-statusless"
          label={translate(
            'components.workspace.cleanup.browse.matchStatusless',
            'Include workspaces with no status'
          )}
          checked={filters.status.matchStatusless}
          onChange={(matchStatusless) => onPatch('status', { matchStatusless })}
        />
        <FacetChoice
          label={translate('components.workspace.cleanup.browse.archived', 'Archived')}
          value={filters.status.archived}
          options={WORKSPACE_CLEANUP_TRI_STATE_VALUES}
          getLabel={getWorkspaceCleanupTriStateLabel}
          onChange={(archived) => onPatch('status', { archived })}
        />
        <FacetChoice
          label={translate('components.workspace.cleanup.browse.pinned', 'Pinned')}
          value={filters.status.pinned}
          options={WORKSPACE_CLEANUP_TRI_STATE_VALUES}
          getLabel={getWorkspaceCleanupTriStateLabel}
          onChange={(pinned) => onPatch('status', { pinned })}
        />
        <FacetChoice
          label={translate('components.workspace.cleanup.browse.unread', 'Unread')}
          value={filters.status.unread}
          options={WORKSPACE_CLEANUP_TRI_STATE_VALUES}
          getLabel={getWorkspaceCleanupTriStateLabel}
          onChange={(unread) => onPatch('status', { unread })}
        />
        <FacetChoice
          label={translate('components.workspace.cleanup.browse.comment', 'Has comment')}
          value={filters.status.comment}
          options={WORKSPACE_CLEANUP_TRI_STATE_VALUES}
          getLabel={getWorkspaceCleanupTriStateLabel}
          onChange={(comment) => onPatch('status', { comment })}
        />
      </FacetSection>

      <FacetSection
        title={translate('components.workspace.cleanup.browse.facet.agent', 'Agent')}
        matchCount={counts.agent}
        totalCount={totalCount}
      >
        <FacetToggleList
          values={WORKSPACE_CLEANUP_AGENT_STATE_VALUES}
          selected={filters.agent.states}
          getLabel={getWorkspaceCleanupAgentStateLabel}
          onChange={(states) => onPatch('agent', { states })}
        />
        <FacetChoice
          label={translate(
            'components.workspace.cleanup.browse.retainedDoneAgents',
            'Finished agent transcripts'
          )}
          value={filters.agent.retainedDoneAgents}
          options={WORKSPACE_CLEANUP_TRI_STATE_VALUES}
          getLabel={getWorkspaceCleanupTriStateLabel}
          onChange={(retainedDoneAgents) => onPatch('agent', { retainedDoneAgents })}
        />
      </FacetSection>

      <FacetSection
        title={translate('components.workspace.cleanup.browse.facet.context', 'Local context')}
        matchCount={counts.context}
        totalCount={totalCount}
      >
        <FacetChoice
          label={translate(
            'components.workspace.cleanup.browse.contextPresence',
            'Open tabs, terminals, comments'
          )}
          value={filters.context.presence}
          options={WORKSPACE_CLEANUP_PRESENCE_VALUES}
          getLabel={getWorkspaceCleanupPresenceLabel}
          onChange={(presence) => onPatch('context', { presence })}
        />
        <FacetCheckbox
          id="context-completely-empty"
          label={translate(
            'components.workspace.cleanup.browse.completelyEmpty',
            'Nothing left to lose'
          )}
          checked={filters.context.completelyEmpty}
          onChange={(completelyEmpty) => onPatch('context', { completelyEmpty })}
        />
      </FacetSection>
    </>
  )
}
