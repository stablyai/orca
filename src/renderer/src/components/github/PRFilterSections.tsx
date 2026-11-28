import React from 'react'
import { ChevronRight } from 'lucide-react'
import {
  MultiSelectList,
  SingleSelectList,
  type PickerOption
} from '@/components/github/PRFilterPickers'
import { cn } from '@/lib/class-names'
import { filterAuthorsValue, filterLabelsValue } from '@/components/github/pr-filter-value-summary'
import type { ParsedTaskQuery } from '../../../../shared/work-items/task-query'
import { translate } from '@/i18n/i18n'
import { useTranslate, type Translate } from '@/i18n/use-translate'

export type PRFilterChange = {
  authors?: string[]
  assignee?: string | null
  reviewer?: { kind: 'requested' | 'reviewed-by'; login: string } | null
  labels?: string[]
  state?: 'open' | 'closed' | 'merged' | 'all'
  draft?: boolean
}

export type SectionKey = 'author' | 'label' | 'reviewer' | 'assignee'

export function filterStateLabel(
  state: 'open' | 'closed' | 'merged',
  t: Translate = translate
): string {
  if (state === 'open') {
    return t('auto.components.github.PRFilterSections.d78b60b5c2', 'Open')
  }
  if (state === 'closed') {
    return t('auto.components.github.PRFilterSections.0fd3249e2e', 'Closed')
  }
  return t('auto.components.github.PRFilterSections.bd162b7d5a', 'Merged')
}

export function filterDraftLabel(t: Translate = translate): string {
  return t('auto.components.github.PRFilterSections.draft', 'Draft')
}

function UserOptionRow({ option }: { option: PickerOption }): React.JSX.Element {
  return (
    <div className="flex min-w-0 flex-col">
      <span className="truncate">{option.primary}</span>
      {option.secondary ? (
        <span className="truncate text-[10px] text-muted-foreground">{option.secondary}</span>
      ) : null}
    </div>
  )
}

export function buildSectionRows(
  parsed: ParsedTaskQuery,
  kind: 'prs' | 'issues',
  reviewerActive: string | null,
  reviewerKind: 'requested' | 'reviewed-by',
  t: Translate
): { key: SectionKey; label: string; value: string | null }[] {
  return [
    {
      key: 'author',
      label: t('auto.components.github.PRFilterSections.24754c44ad', 'Author'),
      value: filterAuthorsValue(parsed.authors, t)
    },
    {
      key: 'label',
      label: t('auto.components.github.PRFilterSections.b1d9fdea08', 'Label'),
      value: filterLabelsValue(parsed.labels, t)
    },
    ...(kind === 'prs'
      ? [
          {
            key: 'reviewer' as SectionKey,
            label:
              reviewerKind === 'reviewed-by'
                ? t('auto.components.github.PRFilterDropdowns.7f1ba66c3e', 'Reviewed by')
                : t('auto.components.github.PRFilterDropdowns.b27b7e526c', 'Review from'),
            value: reviewerActive
          }
        ]
      : []),
    {
      key: 'assignee',
      label: t('auto.components.github.PRFilterSections.ea3416d646', 'Assignee'),
      value: parsed.assignee
    }
  ]
}

export function SectionMenu({
  parsed,
  kind,
  reviewerActive,
  reviewerKind,
  onPick,
  onClearAll
}: {
  parsed: ParsedTaskQuery
  kind: 'prs' | 'issues'
  reviewerActive: string | null
  reviewerKind: 'requested' | 'reviewed-by'
  onPick: (s: SectionKey) => void
  onClearAll: (() => void) | null
}): React.JSX.Element {
  const t = useTranslate()
  const rows = buildSectionRows(parsed, kind, reviewerActive, reviewerKind, t)
  return (
    <div className="py-1 text-xs">
      <div className="px-3 py-1.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
        {kind === 'prs'
          ? t('auto.components.github.PRFilterSections.filterPullRequests', 'Filter pull requests')
          : t('auto.components.github.PRFilterSections.filterIssues', 'Filter issues')}
      </div>
      {rows.map((row) => (
        <button
          key={row.key}
          type="button"
          onClick={() => onPick(row.key)}
          className="flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left transition hover:bg-muted/50"
        >
          <span>{row.label}</span>
          <span className="flex items-center gap-1 text-muted-foreground">
            {row.value ? <span className="max-w-[140px] truncate">{row.value}</span> : null}
            <ChevronRight className="size-3.5" />
          </span>
        </button>
      ))}
      {onClearAll ? (
        <>
          <div className="my-1 h-px bg-border" />
          <button
            type="button"
            onClick={onClearAll}
            className="w-full px-3 py-1.5 text-left text-muted-foreground transition hover:bg-muted/50 hover:text-foreground"
          >
            {t('auto.components.github.PRFilterSections.30ebb6ca44', 'Clear all filters')}
          </button>
        </>
      ) : null}
    </div>
  )
}

export function SectionDetail({
  section,
  parsed,
  authorOpts,
  userOpts,
  labelOpts,
  labelsLoading,
  labelsError,
  usersLoading,
  usersError,
  reviewerMode,
  setReviewerMode,
  onBack,
  onSelect
}: {
  section: SectionKey
  parsed: ParsedTaskQuery
  authorOpts: PickerOption[]
  userOpts: PickerOption[]
  labelOpts: PickerOption[]
  labelsLoading: boolean
  labelsError: string | null
  usersLoading: boolean
  usersError: string | null
  reviewerMode: 'requested' | 'reviewed-by'
  setReviewerMode: (mode: 'requested' | 'reviewed-by') => void
  onBack: () => void
  onSelect: (change: PRFilterChange) => void
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <div>
      <button
        type="button"
        onClick={onBack}
        className="flex w-full items-center gap-1 border-b border-border px-3 py-1.5 text-[11px] text-muted-foreground transition hover:bg-muted/50 hover:text-foreground"
      >
        <ChevronRight className="size-3 rotate-180" />
        {t('auto.components.github.PRFilterSections.b69fa4fa20', 'Back')}
      </button>
      {section === 'author' ? (
        <MultiSelectList
          options={authorOpts}
          selected={parsed.authors}
          loading={false}
          error={null}
          searchPlaceholder={t(
            'auto.components.github.PRFilterSections.filterOrTypeLogin',
            'Filter or type a login...'
          )}
          emptyText={t('auto.components.github.PRFilterSections.458ea3602b', 'No authors')}
          allowCustomValue
          renderOption={(opt) => <UserOptionRow option={opt} />}
          onChange={(next) => onSelect({ authors: next })}
        />
      ) : null}
      {section === 'assignee' ? (
        <SingleSelectList
          options={userOpts}
          activeValue={parsed.assignee}
          loading={usersLoading}
          error={usersError}
          searchPlaceholder={t(
            'auto.components.github.PRFilterSections.filterOrTypeLogin',
            'Filter or type a login...'
          )}
          emptyText={t('auto.components.github.PRFilterSections.a00830d3f7', 'No users')}
          allowCustomValue
          renderOption={(opt) => <UserOptionRow option={opt} />}
          onSelect={(value) => onSelect({ assignee: value })}
        />
      ) : null}
      {section === 'label' ? (
        <MultiSelectList
          options={labelOpts}
          selected={parsed.labels}
          loading={labelsLoading}
          error={labelsError}
          searchPlaceholder={t(
            'auto.components.github.PRFilterSections.filterLabels',
            'Filter labels...'
          )}
          emptyText={t('auto.components.github.PRFilterSections.de26e2eb06', 'No labels')}
          onChange={(next) => onSelect({ labels: next })}
        />
      ) : null}
      {section === 'reviewer' ? (
        <>
          <div className="flex gap-1 border-b border-border p-1.5 text-[11px]">
            <button
              type="button"
              onClick={() => setReviewerMode('requested')}
              className={cn(
                'flex-1 rounded px-2 py-1 transition',
                reviewerMode === 'requested'
                  ? 'bg-foreground/90 text-background'
                  : 'text-muted-foreground hover:bg-muted/50'
              )}
            >
              {t('auto.components.github.PRFilterSections.94b42b0edf', 'Review requested')}
            </button>
            <button
              type="button"
              onClick={() => setReviewerMode('reviewed-by')}
              className={cn(
                'flex-1 rounded px-2 py-1 transition',
                reviewerMode === 'reviewed-by'
                  ? 'bg-foreground/90 text-background'
                  : 'text-muted-foreground hover:bg-muted/50'
              )}
            >
              {t('auto.components.github.PRFilterSections.0103e1cb18', 'Reviewed by')}
            </button>
          </div>
          <SingleSelectList
            options={userOpts}
            activeValue={reviewerMode === 'requested' ? parsed.reviewRequested : parsed.reviewedBy}
            loading={usersLoading}
            error={usersError}
            searchPlaceholder={t(
              'auto.components.github.PRFilterSections.filterOrTypeLogin',
              'Filter or type a login...'
            )}
            emptyText={t('auto.components.github.PRFilterSections.a00830d3f7', 'No users')}
            allowCustomValue
            renderOption={(opt) => <UserOptionRow option={opt} />}
            onSelect={(login) =>
              onSelect({ reviewer: login ? { kind: reviewerMode, login } : null })
            }
          />
        </>
      ) : null}
    </div>
  )
}
