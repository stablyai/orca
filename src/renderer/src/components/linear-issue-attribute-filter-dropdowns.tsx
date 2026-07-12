// Why: Linear Filters chrome mirrors GitHub PR filters — one outline button,
// sectioned popover, removable pills — without encoding facets into free-text search.
import React, { useEffect, useMemo, useRef, useState } from 'react'
import { ListFilter, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { useTeamLabels, useTeamMembers, useTeamStates } from '@/hooks/useIssueMetadata'
import type { RuntimeLinearSettings } from '@/runtime/runtime-linear-client'
import { translate } from '@/i18n/i18n'
import {
  canonicalizeLinearIssueAttributeFilter,
  emptyLinearIssueAttributeFilter,
  type LinearIssueAttributeFilter
} from '../../../shared/linear-issue-attribute-filter'
import type { LinearTeam } from '../../../shared/types'
import {
  LinearIssueFilterSectionDetail,
  LinearIssueFilterSectionMenu,
  clearLinearIssueAttributeFacet,
  countLinearIssueAttributeFilters,
  linearIssueAttributeFilterPillLabels,
  type LinearIssueFilterSectionKey
} from './linear-issue-attribute-filter-sections'

type Props = {
  value: LinearIssueAttributeFilter
  onChange: (next: LinearIssueAttributeFilter) => void
  workspaceId: string | null
  isAllWorkspaces: boolean
  primaryTeam: LinearTeam | null
  selectedTeamCount: number
  settings?: RuntimeLinearSettings
}

function ActivePill({
  label,
  value,
  onClear
}: {
  label: string
  value: string
  onClear: () => void
}): React.JSX.Element {
  return (
    <span className="inline-flex h-6 items-center gap-1 rounded-full border border-border/60 bg-muted/50 pl-2 pr-1 text-[11px] text-foreground">
      <span className="text-muted-foreground">{label}:</span>
      <span className="max-w-[160px] truncate font-medium">{value}</span>
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
  isAllWorkspaces,
  primaryTeam,
  selectedTeamCount,
  settings
}: Props): React.JSX.Element {
  const [popoverOpen, setPopoverOpen] = useState(false)
  const [openSection, setOpenSection] = useState<LinearIssueFilterSectionKey | null>(null)

  const activeTeamId = popoverOpen && !isAllWorkspaces ? (primaryTeam?.id ?? null) : null
  const concreteWorkspaceId =
    popoverOpen && !isAllWorkspaces && workspaceId && workspaceId !== 'all' ? workspaceId : null

  const states = useTeamStates(activeTeamId, settings, concreteWorkspaceId)
  const labels = useTeamLabels(activeTeamId, settings, concreteWorkspaceId)
  const members = useTeamMembers(activeTeamId, settings, concreteWorkspaceId)

  // Why: prune only after a successful non-empty metadata load for the same team;
  // loading/error/empty-before-load must never clear active selections (R12).
  const pruneTeamKeyRef = useRef<string | null>(null)
  useEffect(() => {
    if (!activeTeamId || !concreteWorkspaceId) {
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
    const pruneKey = `${concreteWorkspaceId}::${activeTeamId}`
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
    activeTeamId,
    concreteWorkspaceId,
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

  const statusOptions = useMemo(
    () => states.data.map((state) => ({ key: state.id, primary: state.name })),
    [states.data]
  )
  const labelOptions = useMemo(
    () => labels.data.map((label) => ({ key: label.id, primary: label.name })),
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

  const activeCount = countLinearIssueAttributeFilters(value)
  const pills = linearIssueAttributeFilterPillLabels({
    value,
    stateNamesById,
    memberNamesById,
    labelNamesById
  })

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
          {isAllWorkspaces ? (
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
              {selectedTeamCount > 1 && primaryTeam ? (
                <p className="border-b border-border/50 px-3 py-1.5 text-[11px] text-muted-foreground">
                  {translate(
                    'auto.components.linear-issue-attribute-filter-dropdowns.optionsFromTeam',
                    'Options from {{team}}',
                    { team: primaryTeam.name }
                  )}
                </p>
              ) : null}
              {openSection ? (
                <LinearIssueFilterSectionDetail
                  section={openSection}
                  value={value}
                  onChange={(next) => onChange(canonicalizeLinearIssueAttributeFilter(next))}
                  statusOptions={statusOptions}
                  assigneeOptions={assigneeOptions}
                  labelOptions={labelOptions}
                  statusLoading={states.loading}
                  statusError={states.error}
                  assigneeLoading={members.loading}
                  assigneeError={members.error}
                  labelLoading={labels.loading}
                  labelError={labels.error}
                  teamRequiredMessage={teamRequiredMessage}
                  onBack={() => setOpenSection(null)}
                />
              ) : (
                <LinearIssueFilterSectionMenu value={value} onOpenSection={setOpenSection} />
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
