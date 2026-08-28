import React from 'react'
import { X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { toMegabytes } from './workspace-cleanup-facet-panel-model'
import type { WorkspaceCleanupAppliedFilter } from '../../../../shared/workspace-cleanup-applied-filters'
import { listAppliedWorkspaceCleanupFilters } from '../../../../shared/workspace-cleanup-applied-filters'
import type { WorkspaceCleanupFilterState } from '../../../../shared/workspace-cleanup-filter-model'

/** Why in the bar, not the panel: a filter narrowing the list must be visible without opening anything. */
// Why not memoized: the labels are translated at build time, so caching them on
// `filters` alone reuses the previous language's strings after a language change.
// Derivation is constant-size (one pass over the filter fields, not per row).
export function useAppliedWorkspaceCleanupFilters(
  filters: WorkspaceCleanupFilterState
): WorkspaceCleanupAppliedFilter[] {
  return listAppliedWorkspaceCleanupFilters(filters, buildAppliedFilterFormatters())
}

export function WorkspaceCleanupAppliedFilterChips({
  applied,
  onClear
}: {
  applied: readonly WorkspaceCleanupAppliedFilter[]
  onClear: (filter: WorkspaceCleanupAppliedFilter) => void
}): React.JSX.Element | null {
  if (applied.length === 0) {
    return null
  }
  return (
    <div
      className="flex w-full flex-wrap items-center gap-1"
      role="list"
      aria-label={translate(
        'components.workspace.cleanup.browse.appliedFilters',
        'Applied filters'
      )}
    >
      {applied.map((filter) => (
        <span
          key={filter.id}
          role="listitem"
          className="inline-flex items-center gap-1 rounded-full border border-border bg-background py-0.5 pl-2 pr-1 text-[11px] text-muted-foreground"
        >
          {filter.label}
          <Button
            variant="ghost"
            size="icon-xs"
            className="rounded-full"
            aria-label={translate(
              'components.workspace.cleanup.browse.removeFilter',
              'Remove filter {{value0}}',
              { value0: filter.label }
            )}
            onClick={() => onClear(filter)}
          >
            <X className="size-3" />
          </Button>
        </span>
      ))}
    </div>
  )
}

function buildAppliedFilterFormatters(): Parameters<typeof listAppliedWorkspaceCleanupFilters>[1] {
  const mb = (bytes: number): number => toMegabytes(bytes) ?? 0
  return {
    idleDays: (days) =>
      translate('components.workspace.cleanup.browse.chip.idleDays', 'Idle {{value0}}d+', {
        value0: days
      }),
    neverVisited: () =>
      translate('components.workspace.cleanup.browse.chip.neverVisited', 'Never visited'),
    minSize: (bytes) =>
      translate('components.workspace.cleanup.browse.chip.minSize', 'At least {{value0}} MB', {
        value0: mb(bytes)
      }),
    maxSize: (bytes) =>
      translate('components.workspace.cleanup.browse.chip.maxSize', 'At most {{value0}} MB', {
        value0: mb(bytes)
      }),
    excludesUnsized: () =>
      translate('components.workspace.cleanup.browse.chip.excludesUnsized', 'Measured only'),
    excludesStatusless: () =>
      translate('components.workspace.cleanup.browse.chip.excludesStatusless', 'Has a status'),
    list: (kind, count) =>
      translate('components.workspace.cleanup.browse.chip.list', '{{value0}}: {{value1}}', {
        value0: getChipKindLabel(kind),
        value1: count
      }),
    triState: (kind, mode) =>
      translate('components.workspace.cleanup.browse.chip.triState', '{{value0}}: {{value1}}', {
        value0: getChipKindLabel(kind),
        value1:
          mode === 'only'
            ? translate('components.workspace.cleanup.browse.chip.only', 'Only')
            : translate('components.workspace.cleanup.browse.chip.exclude', 'Excluded')
      }),
    minAhead: (count) =>
      translate('components.workspace.cleanup.browse.chip.minAhead', 'Ahead {{value0}}+', {
        value0: count
      }),
    minBehind: (count) =>
      translate('components.workspace.cleanup.browse.chip.minBehind', 'Behind {{value0}}+', {
        value0: count
      }),
    branchQuery: (value) =>
      translate('components.workspace.cleanup.browse.chip.branchQuery', 'Branch: {{value0}}', {
        value0: value
      }),
    pathPrefix: (value) =>
      translate('components.workspace.cleanup.browse.chip.pathPrefix', 'Path: {{value0}}', {
        value0: value
      }),
    presence: (kind, mode) =>
      translate('components.workspace.cleanup.browse.chip.presence', '{{value0}}: {{value1}}', {
        value0: getChipKindLabel(kind),
        value1:
          mode === 'some'
            ? translate('components.workspace.cleanup.browse.chip.has', 'Has')
            : translate('components.workspace.cleanup.browse.chip.none', 'None')
      }),
    completelyEmpty: () =>
      translate('components.workspace.cleanup.browse.chip.completelyEmpty', 'Nothing to lose')
  }
}

function getChipKindLabel(kind: string): string {
  switch (kind) {
    case 'status':
      return translate('components.workspace.cleanup.browse.chip.kind.status', 'Status')
    case 'agent':
      return translate('components.workspace.cleanup.browse.chip.kind.agent', 'Agent')
    case 'git':
      return translate('components.workspace.cleanup.browse.chip.kind.git', 'Git')
    case 'review':
      return translate('components.workspace.cleanup.browse.chip.kind.review', 'Review')
    case 'reviewState':
      return translate('components.workspace.cleanup.browse.chip.kind.reviewState', 'Review state')
    case 'reviewProvider':
      return translate('components.workspace.cleanup.browse.chip.kind.reviewProvider', 'Provider')
    case 'ticket':
      return translate('components.workspace.cleanup.browse.chip.kind.ticket', 'Ticket')
    case 'ticketSource':
      return translate(
        'components.workspace.cleanup.browse.chip.kind.ticketSource',
        'Ticket source'
      )
    case 'context':
      return translate('components.workspace.cleanup.browse.chip.kind.context', 'Context')
    case 'host':
      return translate('components.workspace.cleanup.browse.chip.kind.host', 'Host')
    case 'repo':
      return translate('components.workspace.cleanup.browse.chip.kind.repo', 'Repo')
    case 'blocker':
      return translate('components.workspace.cleanup.browse.chip.kind.blocker', 'Blocker')
    case 'dismissed':
      return translate('components.workspace.cleanup.browse.chip.kind.dismissed', 'Ignored')
    case 'archived':
      return translate('components.workspace.cleanup.browse.chip.kind.archived', 'Archived')
    case 'pinned':
      return translate('components.workspace.cleanup.browse.chip.kind.pinned', 'Pinned')
    case 'unread':
      return translate('components.workspace.cleanup.browse.chip.kind.unread', 'Unread')
    case 'comment':
      return translate('components.workspace.cleanup.browse.chip.kind.comment', 'Comment')
    case 'prunable':
      return translate('components.workspace.cleanup.browse.chip.kind.prunable', 'Prunable')
    case 'locked':
      return translate('components.workspace.cleanup.browse.chip.kind.locked', 'Locked')
    case 'retainedAgents':
      return translate(
        'components.workspace.cleanup.browse.chip.kind.retainedAgents',
        'Finished agents'
      )
    default:
      return kind
  }
}
