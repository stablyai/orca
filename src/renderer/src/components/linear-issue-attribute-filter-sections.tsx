import React from 'react'
import { ChevronRight } from 'lucide-react'
import {
  MultiSelectList,
  SingleSelectList,
  type PickerOption
} from '@/components/github/PRFilterPickers'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import {
  LINEAR_ISSUE_ATTRIBUTE_FILTER_MAX_LABEL_IDS,
  LINEAR_ISSUE_ATTRIBUTE_FILTER_MAX_STATE_IDS,
  type LinearIssueAttributeFilter
} from '../../../shared/linear/issue-attribute-filter'
import { getLinearPriorityLabel } from './task-page-localized-options'
import { LinearFacetCoverageNotice } from './linear-issue-attribute-filter-coverage-notice'
import {
  expandLinearMetadataGroupKeys,
  isLinearMetadataGroupSelectionPartial,
  selectedLinearMetadataGroupKeys
} from './linear-issue-attribute-filter-team-ids'

export type LinearIssueFilterSectionKey = 'status' | 'priority' | 'assignee' | 'labels'

/** Picker row backed by every same-named id across the selected teams (#16785). */
export type LinearIssueFilterGroupedOption = PickerOption & { ids: string[] }

function priorityOptions(): PickerOption[] {
  return [0, 1, 2, 3, 4].map((priority) => ({
    key: String(priority),
    primary: getLinearPriorityLabel(priority)
  }))
}

type LinearIssueFilterSectionSummary = { text: string; partial: boolean }

/** "{{count}} selected", flagged when the transport id cap left teams out (#16879). */
function facetSummary(
  options: readonly LinearIssueFilterGroupedOption[],
  selectedIds: readonly string[],
  truncated: boolean
): LinearIssueFilterSectionSummary {
  const count = selectedLinearMetadataGroupKeys(options, selectedIds).length
  if (count === 0) {
    return { text: '', partial: false }
  }
  return {
    text: translate(
      'auto.components.linear-issue-attribute-filter-sections.countSelected',
      '{{count}} selected',
      { count }
    ),
    partial: isLinearMetadataGroupSelectionPartial(options, selectedIds, truncated)
  }
}

function plainSummary(text: string): LinearIssueFilterSectionSummary {
  return { text, partial: false }
}

export function LinearIssueFilterSectionMenu({
  value,
  statusOptions,
  labelOptions,
  statusTruncated,
  labelsTruncated,
  onOpenSection
}: {
  value: LinearIssueAttributeFilter
  statusOptions: LinearIssueFilterGroupedOption[]
  labelOptions: LinearIssueFilterGroupedOption[]
  statusTruncated: boolean
  labelsTruncated: boolean
  onOpenSection: (section: LinearIssueFilterSectionKey) => void
}): React.JSX.Element {
  const sections: {
    key: LinearIssueFilterSectionKey
    label: string
    summary: LinearIssueFilterSectionSummary
  }[] = [
    {
      key: 'status',
      label: translate('auto.components.linear-issue-attribute-filter-sections.status', 'Status'),
      summary: facetSummary(statusOptions, value.stateIds, statusTruncated)
    },
    {
      key: 'priority',
      label: translate(
        'auto.components.linear-issue-attribute-filter-sections.priority',
        'Priority'
      ),
      summary: plainSummary(
        value.priorities.length > 0
          ? translate(
              'auto.components.linear-issue-attribute-filter-sections.countSelected',
              '{{count}} selected',
              { count: value.priorities.length }
            )
          : ''
      )
    },
    {
      key: 'assignee',
      label: translate(
        'auto.components.linear-issue-attribute-filter-sections.assignee',
        'Assignee'
      ),
      summary: plainSummary(
        value.assignee
          ? value.assignee.kind === 'unassigned'
            ? translate(
                'auto.components.linear-issue-attribute-filter-sections.unassigned',
                'Unassigned'
              )
            : translate(
                'auto.components.linear-issue-attribute-filter-sections.selected',
                'selected'
              )
          : ''
      )
    },
    {
      key: 'labels',
      label: translate('auto.components.linear-issue-attribute-filter-sections.labels', 'Labels'),
      summary: facetSummary(labelOptions, value.labelIds, labelsTruncated)
    }
  ]

  return (
    <div className="py-1 text-xs">
      {sections.map((section) => (
        <button
          key={section.key}
          type="button"
          onClick={() => onOpenSection(section.key)}
          className="flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left transition hover:bg-muted/50"
        >
          <span className="font-medium">{section.label}</span>
          <span className="inline-flex min-w-0 items-center gap-1 text-muted-foreground">
            {section.summary.text ? (
              <span className="min-w-0 truncate">{section.summary.text}</span>
            ) : null}
            {/* Why: the marker sits outside the truncating span so a long count never clips it. */}
            {section.summary.partial ? (
              <span className="shrink-0">
                {translate(
                  'auto.components.linear-issue-attribute-filter-sections.partialCoverageMarker',
                  '· partial'
                )}
              </span>
            ) : null}
            <ChevronRight className="size-3.5 shrink-0" />
          </span>
        </button>
      ))}
    </div>
  )
}

export function LinearIssueFilterSectionDetail({
  section,
  value,
  onChange,
  statusOptions,
  assigneeOptions,
  labelOptions,
  statusLoading,
  statusError,
  assigneeLoading,
  assigneeError,
  labelLoading,
  labelError,
  statusTruncated,
  labelsTruncated,
  teamRequiredMessage,
  onBack
}: {
  section: LinearIssueFilterSectionKey
  value: LinearIssueAttributeFilter
  onChange: (next: LinearIssueAttributeFilter) => void
  statusOptions: LinearIssueFilterGroupedOption[]
  assigneeOptions: PickerOption[]
  labelOptions: LinearIssueFilterGroupedOption[]
  statusLoading: boolean
  statusError: string | null
  assigneeLoading: boolean
  assigneeError: string | null
  labelLoading: boolean
  labelError: string | null
  statusTruncated: boolean
  labelsTruncated: boolean
  teamRequiredMessage: string | null
  onBack: () => void
}): React.JSX.Element {
  if (section === 'priority') {
    return (
      <div>
        <SectionBack onBack={onBack} />
        <MultiSelectList
          options={priorityOptions()}
          selected={value.priorities.map(String)}
          loading={false}
          error={null}
          searchPlaceholder={translate(
            'auto.components.linear-issue-attribute-filter-sections.searchPriority',
            'Filter priority…'
          )}
          onChange={(keys) =>
            onChange({
              ...value,
              priorities: keys
                .map((key) => Number.parseInt(key, 10))
                .filter((n) => Number.isInteger(n) && n >= 0 && n <= 4)
            })
          }
        />
      </div>
    )
  }

  if (
    teamRequiredMessage &&
    (section === 'status' || section === 'labels' || section === 'assignee')
  ) {
    return (
      <div>
        <SectionBack onBack={onBack} />
        {section === 'assignee' ? (
          <div className="px-3 py-1.5">
            <button
              type="button"
              className={cn(
                'w-full rounded-md px-2 py-1.5 text-left text-xs transition hover:bg-muted/50',
                value.assignee?.kind === 'unassigned' && 'bg-muted/40 font-medium'
              )}
              onClick={() =>
                onChange({
                  ...value,
                  assignee: value.assignee?.kind === 'unassigned' ? null : { kind: 'unassigned' }
                })
              }
            >
              {translate(
                'auto.components.linear-issue-attribute-filter-sections.unassigned',
                'Unassigned'
              )}
            </button>
          </div>
        ) : null}
        <p className="px-3 py-2 text-xs text-muted-foreground">{teamRequiredMessage}</p>
      </div>
    )
  }

  // Status and labels are the same grouped, cap-bounded picker over a different facet.
  if (section === 'status' || section === 'labels') {
    const isStatus = section === 'status'
    const options = isStatus ? statusOptions : labelOptions
    const selectedIds = isStatus ? value.stateIds : value.labelIds
    return (
      <div>
        <SectionBack onBack={onBack} />
        <MultiSelectList
          options={options}
          selected={selectedLinearMetadataGroupKeys(options, selectedIds)}
          loading={isStatus ? statusLoading : labelLoading}
          error={isStatus ? statusError : labelError}
          searchPlaceholder={
            isStatus
              ? translate(
                  'auto.components.linear-issue-attribute-filter-sections.searchStatus',
                  'Filter status…'
                )
              : translate(
                  'auto.components.linear-issue-attribute-filter-sections.searchLabels',
                  'Filter labels…'
                )
          }
          onChange={(keys) => {
            const ids = expandLinearMetadataGroupKeys(options, keys)
            onChange(isStatus ? { ...value, stateIds: ids } : { ...value, labelIds: ids })
          }}
        />
        <LinearFacetCoverageNotice
          facet={section}
          options={options}
          selectedIds={selectedIds}
          max={
            isStatus
              ? LINEAR_ISSUE_ATTRIBUTE_FILTER_MAX_STATE_IDS
              : LINEAR_ISSUE_ATTRIBUTE_FILTER_MAX_LABEL_IDS
          }
          truncated={isStatus ? statusTruncated : labelsTruncated}
        />
      </div>
    )
  }

  const activeAssignee =
    value.assignee?.kind === 'unassigned'
      ? '__unassigned__'
      : value.assignee?.kind === 'user'
        ? value.assignee.id
        : null

  return (
    <div>
      <SectionBack onBack={onBack} />
      <SingleSelectList
        options={[
          {
            key: '__unassigned__',
            primary: translate(
              'auto.components.linear-issue-attribute-filter-sections.unassigned',
              'Unassigned'
            )
          },
          ...assigneeOptions
        ]}
        activeValue={activeAssignee}
        loading={assigneeLoading}
        error={assigneeError}
        searchPlaceholder={translate(
          'auto.components.linear-issue-attribute-filter-sections.searchAssignee',
          'Filter assignee…'
        )}
        onSelect={(key) => {
          if (!key) {
            onChange({ ...value, assignee: null })
            return
          }
          if (key === '__unassigned__') {
            onChange({ ...value, assignee: { kind: 'unassigned' } })
            return
          }
          onChange({ ...value, assignee: { kind: 'user', id: key } })
        }}
      />
    </div>
  )
}

function SectionBack({ onBack }: { onBack: () => void }): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onBack}
      className="flex w-full items-center gap-1 border-b border-border/50 px-3 py-1.5 text-left text-xs text-muted-foreground transition hover:bg-muted/40 hover:text-foreground"
    >
      {translate('auto.components.linear-issue-attribute-filter-sections.back', 'Back')}
    </button>
  )
}
