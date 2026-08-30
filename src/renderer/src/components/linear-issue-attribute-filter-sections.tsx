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
  canonicalizeLinearIssueAttributeFilter,
  type LinearIssueAttributeFilter
} from '../../../shared/linear/issue-attribute-filter'
import { getLinearPriorityLabel } from './task-page-localized-options'
import { LinearFacetCoverageNotice } from './linear-issue-attribute-filter-coverage-notice'
import {
  expandLinearMetadataGroupKeys,
  selectedLinearMetadataGroupKeys
} from './linear-issue-attribute-filter-team-ids'

export type LinearIssueFilterSectionKey = 'status' | 'priority' | 'assignee' | 'labels'

/** Picker row backed by every same-named id across the selected teams (#16785). */
export type LinearIssueFilterGroupedOption = PickerOption & { ids: string[] }

/** Same-named ids from different teams are one selection to the user. */
function distinctFacetNames(ids: readonly string[], namesById: Map<string, string>): string[] {
  return [...new Set(ids.map((id) => namesById.get(id) ?? id))]
}

export function countLinearIssueAttributeFilters(value: LinearIssueAttributeFilter): number {
  const canonical = canonicalizeLinearIssueAttributeFilter(value)
  return (
    (canonical.stateIds.length > 0 ? 1 : 0) +
    (canonical.priorities.length > 0 ? 1 : 0) +
    (canonical.assignee ? 1 : 0) +
    (canonical.labelIds.length > 0 ? 1 : 0)
  )
}

export function clearLinearIssueAttributeFacet(
  value: LinearIssueAttributeFilter,
  facet: LinearIssueFilterSectionKey
): LinearIssueAttributeFilter {
  switch (facet) {
    case 'status':
      return { ...value, stateIds: [] }
    case 'priority':
      return { ...value, priorities: [] }
    case 'assignee':
      return { ...value, assignee: null }
    case 'labels':
      return { ...value, labelIds: [] }
  }
}

export function linearIssueAttributeFilterPillLabels(options: {
  value: LinearIssueAttributeFilter
  stateNamesById: Map<string, string>
  memberNamesById: Map<string, string>
  labelNamesById: Map<string, string>
}): { key: LinearIssueFilterSectionKey; label: string; value: string }[] {
  const canonical = canonicalizeLinearIssueAttributeFilter(options.value)
  const pills: { key: LinearIssueFilterSectionKey; label: string; value: string }[] = []
  if (canonical.stateIds.length > 0) {
    pills.push({
      key: 'status',
      label: translate('auto.components.linear-issue-attribute-filter-sections.status', 'Status'),
      value: distinctFacetNames(canonical.stateIds, options.stateNamesById).join(', ')
    })
  }
  if (canonical.priorities.length > 0) {
    pills.push({
      key: 'priority',
      label: translate(
        'auto.components.linear-issue-attribute-filter-sections.priority',
        'Priority'
      ),
      value: canonical.priorities.map((p) => getLinearPriorityLabel(p)).join(', ')
    })
  }
  if (canonical.assignee?.kind === 'unassigned') {
    pills.push({
      key: 'assignee',
      label: translate(
        'auto.components.linear-issue-attribute-filter-sections.assignee',
        'Assignee'
      ),
      value: translate(
        'auto.components.linear-issue-attribute-filter-sections.unassigned',
        'Unassigned'
      )
    })
  } else if (canonical.assignee?.kind === 'user') {
    pills.push({
      key: 'assignee',
      label: translate(
        'auto.components.linear-issue-attribute-filter-sections.assignee',
        'Assignee'
      ),
      value: options.memberNamesById.get(canonical.assignee.id) ?? canonical.assignee.id
    })
  }
  if (canonical.labelIds.length > 0) {
    pills.push({
      key: 'labels',
      label: translate('auto.components.linear-issue-attribute-filter-sections.labels', 'Labels'),
      value: distinctFacetNames(canonical.labelIds, options.labelNamesById).join(', ')
    })
  }
  return pills
}

function priorityOptions(): PickerOption[] {
  return [0, 1, 2, 3, 4].map((priority) => ({
    key: String(priority),
    primary: getLinearPriorityLabel(priority)
  }))
}

export function LinearIssueFilterSectionMenu({
  value,
  stateNamesById,
  labelNamesById,
  onOpenSection
}: {
  value: LinearIssueAttributeFilter
  stateNamesById: Map<string, string>
  labelNamesById: Map<string, string>
  onOpenSection: (section: LinearIssueFilterSectionKey) => void
}): React.JSX.Element {
  const selectedStatusCount = distinctFacetNames(value.stateIds, stateNamesById).length
  const selectedLabelCount = distinctFacetNames(value.labelIds, labelNamesById).length
  const sections: { key: LinearIssueFilterSectionKey; label: string; summary: string }[] = [
    {
      key: 'status',
      label: translate('auto.components.linear-issue-attribute-filter-sections.status', 'Status'),
      summary:
        selectedStatusCount > 0
          ? translate(
              'auto.components.linear-issue-attribute-filter-sections.countSelected',
              '{{count}} selected',
              { count: selectedStatusCount }
            )
          : ''
    },
    {
      key: 'priority',
      label: translate(
        'auto.components.linear-issue-attribute-filter-sections.priority',
        'Priority'
      ),
      summary:
        value.priorities.length > 0
          ? translate(
              'auto.components.linear-issue-attribute-filter-sections.countSelected',
              '{{count}} selected',
              { count: value.priorities.length }
            )
          : ''
    },
    {
      key: 'assignee',
      label: translate(
        'auto.components.linear-issue-attribute-filter-sections.assignee',
        'Assignee'
      ),
      summary: value.assignee
        ? value.assignee.kind === 'unassigned'
          ? translate(
              'auto.components.linear-issue-attribute-filter-sections.unassigned',
              'Unassigned'
            )
          : translate('auto.components.linear-issue-attribute-filter-sections.selected', 'selected')
        : ''
    },
    {
      key: 'labels',
      label: translate('auto.components.linear-issue-attribute-filter-sections.labels', 'Labels'),
      summary:
        selectedLabelCount > 0
          ? translate(
              'auto.components.linear-issue-attribute-filter-sections.countSelected',
              '{{count}} selected',
              { count: selectedLabelCount }
            )
          : ''
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
          <span className="inline-flex items-center gap-1 text-muted-foreground">
            {section.summary ? (
              <span className="max-w-[120px] truncate">{section.summary}</span>
            ) : null}
            <ChevronRight className="size-3.5" />
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

  if (section === 'status') {
    return (
      <div>
        <SectionBack onBack={onBack} />
        <MultiSelectList
          options={statusOptions}
          selected={selectedLinearMetadataGroupKeys(statusOptions, value.stateIds)}
          loading={statusLoading}
          error={statusError}
          searchPlaceholder={translate(
            'auto.components.linear-issue-attribute-filter-sections.searchStatus',
            'Filter status…'
          )}
          onChange={(keys) =>
            onChange({ ...value, stateIds: expandLinearMetadataGroupKeys(statusOptions, keys) })
          }
        />
        <LinearFacetCoverageNotice
          facet="status"
          options={statusOptions}
          selectedIds={value.stateIds}
        />
      </div>
    )
  }

  if (section === 'labels') {
    return (
      <div>
        <SectionBack onBack={onBack} />
        <MultiSelectList
          options={labelOptions}
          selected={selectedLinearMetadataGroupKeys(labelOptions, value.labelIds)}
          loading={labelLoading}
          error={labelError}
          searchPlaceholder={translate(
            'auto.components.linear-issue-attribute-filter-sections.searchLabels',
            'Filter labels…'
          )}
          onChange={(keys) =>
            onChange({ ...value, labelIds: expandLinearMetadataGroupKeys(labelOptions, keys) })
          }
        />
        <LinearFacetCoverageNotice
          facet="labels"
          options={labelOptions}
          selectedIds={value.labelIds}
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
