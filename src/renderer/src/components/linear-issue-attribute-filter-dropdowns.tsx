// Why: Linear Filters chrome mirrors GitHub PR filters — one outline button,
// sectioned popover, removable pills — without encoding facets into free-text search.
import React, { useEffect, useMemo, useRef, useState } from 'react'
import { ListFilter, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useTeamsLabels, useTeamsMembers, useTeamsStates } from '@/hooks/useIssueMetadata'
import type { RuntimeLinearSettings } from '@/runtime/runtime-linear-client'
import { translate } from '@/i18n/i18n'
import {
  LINEAR_ISSUE_ATTRIBUTE_FILTER_MAX_LABEL_IDS,
  LINEAR_ISSUE_ATTRIBUTE_FILTER_MAX_STATE_IDS,
  boundLinearIssueAttributeFilter,
  canonicalizeLinearIssueAttributeFilter,
  emptyLinearIssueAttributeFilter,
  type LinearIssueAttributeFilter
} from '../../../shared/linear/issue-attribute-filter'
import type { LinearTeam } from '../../../shared/linear/workspace-types'
import {
  clearLinearIssueAttributeFacet,
  countLinearIssueAttributeFilters,
  linearIssueAttributeFilterPillLabels
} from './linear-issue-attribute-filter-pills'
import {
  LinearIssueFilterSectionDetail,
  LinearIssueFilterSectionMenu,
  type LinearIssueFilterSectionKey
} from './linear-issue-attribute-filter-sections'
import {
  capLinearMetadataIdsAcrossGroups,
  groupLinearMetadataByName,
  isLinearMetadataTruncated,
  recordLinearMetadataTruncation,
  resolveLinearIssueAttributeFilterTeamIds,
  type LinearMetadataTruncationRecord
} from './linear-issue-attribute-filter-team-ids'

type Props = {
  value: LinearIssueAttributeFilter
  onChange: (next: LinearIssueAttributeFilter) => void
  /** `null` or `all` means no single workspace owns the facet ids. */
  workspaceId: string | null
  primaryTeam: LinearTeam | null
  /** Selected Linear team ids (All teams / multi-select). Empty → primary fallback. */
  selectedTeamIds: readonly string[]
  availableTeams: readonly LinearTeam[]
  /** False while `availableTeams` is still the issue-scraped fallback, not the real fetch. */
  teamsSettled: boolean
  settings?: RuntimeLinearSettings
}

function ActivePill({
  label,
  value,
  partial,
  onClear
}: {
  label: string
  value: string
  partial: boolean
  onClear: () => void
}): React.JSX.Element {
  return (
    <span className="inline-flex h-6 items-center gap-1 rounded-full border border-border/60 bg-muted/50 pl-2 pr-1 text-[11px] text-foreground">
      <span className="text-muted-foreground">{label}:</span>
      <span className="max-w-[160px] truncate font-medium">{value}</span>
      {partial ? (
        <Tooltip>
          <TooltipTrigger asChild>
            {/* Why: a bare title attribute reaches neither keyboard nor screen reader. */}
            <button
              type="button"
              className="rounded-sm text-muted-foreground underline decoration-dotted underline-offset-2 outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
            >
              {translate(
                'auto.components.linear-issue-attribute-filter-dropdowns.partialCoverage',
                'partial'
              )}
            </button>
          </TooltipTrigger>
          <TooltipContent side="top" sideOffset={4}>
            {translate(
              'auto.components.linear-issue-attribute-filter-dropdowns.partialCoverageTitle',
              'Some teams may be left out of this filter. Open Filters for details.'
            )}
          </TooltipContent>
        </Tooltip>
      ) : null}
      <button
        type="button"
        aria-label={translate(
          'auto.components.linear-issue-attribute-filter-dropdowns.removeFilter',
          'Remove {{value0}} filter',
          { value0: label }
        )}
        onClick={onClear}
        className="rounded-full p-0.5 text-muted-foreground transition hover:bg-muted hover:text-foreground"
      >
        <X className="size-3" />
      </button>
    </span>
  )
}

export default function LinearIssueAttributeFilterDropdowns({
  value,
  onChange,
  workspaceId,
  primaryTeam,
  selectedTeamIds,
  availableTeams,
  teamsSettled,
  settings
}: Props): React.JSX.Element {
  const [popoverOpen, setPopoverOpen] = useState(false)
  const [openSection, setOpenSection] = useState<LinearIssueFilterSectionKey | null>(null)
  // Why: each record holds the ids the cap left behind, so it stops applying the moment the
  // facet carries anything else — prune, pill clear, Clear all, workspace switch (STA-5996).
  const [stateIdsTruncation, setStateIdsTruncation] = useState<LinearMetadataTruncationRecord>(null)
  const [labelIdsTruncation, setLabelIdsTruncation] = useState<LinearMetadataTruncationRecord>(null)
  const statusTruncated = isLinearMetadataTruncated(stateIdsTruncation, value.stateIds)
  const labelsTruncated = isLinearMetadataTruncated(labelIdsTruncation, value.labelIds)
  const activeCount = countLinearIssueAttributeFilters(value)
  const metadataNeeded =
    popoverOpen ||
    value.stateIds.length > 0 ||
    value.labelIds.length > 0 ||
    value.assignee?.kind === 'user'

  // Why: facet ids belong to one workspace, so an unresolved id is as unusable as `all`
  // — both must show the picker hint rather than accept a filter that goes nowhere.
  const scopedWorkspaceId = workspaceId && workspaceId !== 'all' ? workspaceId : null

  const activeTeamIds = useMemo(() => {
    if (!metadataNeeded || !scopedWorkspaceId) {
      return [] as string[]
    }
    return resolveLinearIssueAttributeFilterTeamIds({
      selectedTeamIds,
      availableTeams,
      primaryTeamId: primaryTeam?.id ?? null
    })
  }, [metadataNeeded, scopedWorkspaceId, selectedTeamIds, availableTeams, primaryTeam?.id])

  const concreteWorkspaceId = metadataNeeded ? scopedWorkspaceId : null

  // Why: multi-team / All teams must union filter options across every selected team (#8739).
  const states = useTeamsStates(activeTeamIds, settings, concreteWorkspaceId)
  const labels = useTeamsLabels(activeTeamIds, settings, concreteWorkspaceId)
  const members = useTeamsMembers(activeTeamIds, settings, concreteWorkspaceId)

  // Why: prune only after a successful non-empty metadata load for the same team set;
  // loading/error/empty-before-load must never clear active selections (R12).
  const pruneTeamKeyRef = useRef<string | null>(null)
  useEffect(() => {
    if (activeTeamIds.length === 0 || !concreteWorkspaceId) {
      return
    }
    // Why: restored filters make this run at startup, when availableTeams may still be
    // the issue-scraped subset. Metadata complete for a partial team set looks valid,
    // so pruning there would permanently delete facets from another team (R12).
    if (!teamsSettled) {
      return
    }
    if (states.loading || labels.loading || members.loading) {
      return
    }
    if (states.error || labels.error || members.error) {
      return
    }
    if (states.data.length === 0 && labels.data.length === 0 && members.data.length === 0) {
      return
    }
    const pruneKey = `${concreteWorkspaceId}::${activeTeamIds.join(',')}`
    if (pruneTeamKeyRef.current === pruneKey) {
      return
    }
    pruneTeamKeyRef.current = pruneKey
    const stateIds = new Set(states.data.map((s) => s.id))
    const labelIds = new Set(labels.data.map((l) => l.id))
    const memberIds = new Set(members.data.map((m) => m.id))
    const next: LinearIssueAttributeFilter = {
      ...value,
      stateIds: value.stateIds.filter((id) => stateIds.has(id)),
      labelIds: value.labelIds.filter((id) => labelIds.has(id)),
      assignee:
        value.assignee?.kind === 'user' && !memberIds.has(value.assignee.id) ? null : value.assignee
    }
    const canonicalNext = canonicalizeLinearIssueAttributeFilter(next)
    const canonicalValue = canonicalizeLinearIssueAttributeFilter(value)
    if (JSON.stringify(canonicalNext) !== JSON.stringify(canonicalValue)) {
      onChange(canonicalNext)
    }
  }, [
    activeTeamIds,
    concreteWorkspaceId,
    teamsSettled,
    states.loading,
    states.error,
    states.data,
    labels.loading,
    labels.error,
    labels.data,
    members.loading,
    members.error,
    members.data,
    value,
    onChange
  ])

  // Why: workflow states and team labels are per team, so several ids share one name —
  // one row per name, selecting every id behind it (#16785).
  const statusOptions = useMemo(
    () =>
      groupLinearMetadataByName(states.data).map((group) => ({
        key: group.key,
        primary: group.name,
        ids: group.ids
      })),
    [states.data]
  )
  const labelOptions = useMemo(
    () =>
      groupLinearMetadataByName(labels.data).map((group) => ({
        key: group.key,
        primary: group.name,
        ids: group.ids
      })),
    [labels.data]
  )
  const assigneeOptions = useMemo(
    () =>
      members.data.map((member) => ({
        key: member.id,
        primary: member.displayName || member.id
      })),
    [members.data]
  )

  const stateNamesById = useMemo(
    () => new Map(states.data.map((state) => [state.id, state.name] as const)),
    [states.data]
  )
  const labelNamesById = useMemo(
    () => new Map(labels.data.map((label) => [label.id, label.name] as const)),
    [labels.data]
  )
  const memberNamesById = useMemo(
    () =>
      new Map(members.data.map((member) => [member.id, member.displayName || member.id] as const)),
    [members.data]
  )

  const pills = linearIssueAttributeFilterPillLabels({
    value,
    stateNamesById,
    memberNamesById,
    labelNamesById,
    statusOptions,
    labelOptions,
    statusTruncated,
    labelsTruncated
  })

  // Why: one picked row expands to an id per team, so bound here — the IPC/RPC parser rejects a
  // filter over the transport cap outright. Spread the cap over the picked rows first: the
  // canonical slice is lexicographic, so it can drop every id of a row the user just checked.
  const applyPickedFilter = (next: LinearIssueAttributeFilter): void => {
    const bounded = boundLinearIssueAttributeFilter(
      canonicalizeLinearIssueAttributeFilter({
        ...next,
        stateIds: capLinearMetadataIdsAcrossGroups(
          statusOptions,
          next.stateIds,
          LINEAR_ISSUE_ATTRIBUTE_FILTER_MAX_STATE_IDS
        ),
        labelIds: capLinearMetadataIdsAcrossGroups(
          labelOptions,
          next.labelIds,
          LINEAR_ISSUE_ATTRIBUTE_FILTER_MAX_LABEL_IDS
        )
      })
    )
    // Why: only here are the pre-cap expansion and the survivors both in hand. Re-capping an
    // untouched facet (a priority click) is a no-op, so keep a record that still matches.
    setStateIdsTruncation(
      isLinearMetadataTruncated(stateIdsTruncation, bounded.stateIds)
        ? stateIdsTruncation
        : recordLinearMetadataTruncation(next.stateIds, bounded.stateIds)
    )
    setLabelIdsTruncation(
      isLinearMetadataTruncated(labelIdsTruncation, bounded.labelIds)
        ? labelIdsTruncation
        : recordLinearMetadataTruncation(next.labelIds, bounded.labelIds)
    )
    onChange(bounded)
  }

  const teamRequiredMessage = !primaryTeam
    ? translate(
        'auto.components.linear-issue-attribute-filter-dropdowns.teamRequired',
        'Select a team to load status, assignees, and labels for this workspace.'
      )
    : null

  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1.5">
      <Popover
        open={popoverOpen}
        onOpenChange={(open) => {
          setPopoverOpen(open)
          if (!open) {
            setOpenSection(null)
          }
        }}
      >
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-7 gap-1.5 px-2 text-xs"
            aria-label={translate(
              'auto.components.linear-issue-attribute-filter-dropdowns.filters',
              'Filters'
            )}
          >
            <ListFilter className="size-3.5" />
            {translate(
              'auto.components.linear-issue-attribute-filter-dropdowns.filters',
              'Filters'
            )}
            {activeCount > 0 ? (
              <span className="rounded-full bg-muted px-1.5 text-[10px] font-medium text-muted-foreground">
                {activeCount}
              </span>
            ) : null}
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-72 p-0">
          {!scopedWorkspaceId ? (
            <div className="space-y-2 p-3 text-xs">
              <p className="font-medium text-foreground">
                {translate(
                  'auto.components.linear-issue-attribute-filter-dropdowns.allWorkspacesTitle',
                  'Select one workspace'
                )}
              </p>
              <p className="text-muted-foreground">
                {translate(
                  'auto.components.linear-issue-attribute-filter-dropdowns.allWorkspacesBody',
                  'Status, assignee, and label filters use ids from a single Linear workspace. Choose one workspace to filter by those attributes.'
                )}
              </p>
            </div>
          ) : (
            <>
              {openSection ? (
                <LinearIssueFilterSectionDetail
                  section={openSection}
                  value={value}
                  onChange={applyPickedFilter}
                  statusOptions={statusOptions}
                  assigneeOptions={assigneeOptions}
                  labelOptions={labelOptions}
                  statusLoading={states.loading}
                  statusError={states.error}
                  assigneeLoading={members.loading}
                  assigneeError={members.error}
                  labelLoading={labels.loading}
                  labelError={labels.error}
                  statusTruncated={statusTruncated}
                  labelsTruncated={labelsTruncated}
                  teamRequiredMessage={teamRequiredMessage}
                  onBack={() => setOpenSection(null)}
                />
              ) : (
                <LinearIssueFilterSectionMenu
                  value={value}
                  statusOptions={statusOptions}
                  labelOptions={labelOptions}
                  statusTruncated={statusTruncated}
                  labelsTruncated={labelsTruncated}
                  onOpenSection={setOpenSection}
                />
              )}
              {activeCount > 0 ? (
                <div className="border-t border-border/50 p-2">
                  <button
                    type="button"
                    className="w-full rounded-md px-2 py-1.5 text-left text-xs text-muted-foreground transition hover:bg-muted/50 hover:text-foreground"
                    onClick={() => onChange(emptyLinearIssueAttributeFilter())}
                  >
                    {translate(
                      'auto.components.linear-issue-attribute-filter-dropdowns.clearAll',
                      'Clear all filters'
                    )}
                  </button>
                </div>
              ) : null}
            </>
          )}
        </PopoverContent>
      </Popover>

      {pills.map((pill) => (
        <ActivePill
          key={pill.key}
          label={pill.label}
          value={pill.value}
          partial={pill.partial}
          onClear={() =>
            onChange(
              canonicalizeLinearIssueAttributeFilter(
                clearLinearIssueAttributeFacet(value, pill.key)
              )
            )
          }
        />
      ))}
    </div>
  )
}
