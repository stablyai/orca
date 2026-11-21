import React, { useState } from 'react'
import { ListFilter, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/class-names'
import type { PickerOption } from '@/components/github/PRFilterPickers'
import { filterAuthorsValue, filterLabelsValue } from '@/components/github/pr-filter-value-summary'
import {
  filterDraftLabel,
  filterStateLabel,
  SectionDetail,
  SectionMenu,
  type PRFilterChange,
  type SectionKey
} from '@/components/github/PRFilterSections'
import type { ParsedTaskQuery } from '../../../../shared/work-items/task-query'
import { useTranslate } from '@/i18n/use-translate'

function ActivePill({
  label,
  value,
  onClear
}: {
  label: string
  value: string
  onClear: () => void
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <span className="inline-flex h-6 items-center gap-1 rounded-full border border-border/60 bg-muted/50 pl-2 pr-1 text-[11px] text-foreground">
      <span className="text-muted-foreground">{label}:</span>
      <span className="max-w-[160px] truncate font-medium">{value}</span>
      <button
        type="button"
        aria-label={t(
          'auto.components.github.PRFilterDropdowns.8a2ffbf9b3',
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

type TaskFilterMenuProps = {
  parsed: ParsedTaskQuery
  kind: 'prs' | 'issues'
  open: boolean
  onOpenChange: (open: boolean) => void
  labelOpts: PickerOption[]
  labelsLoading: boolean
  labelsError: string | null
  authorOpts?: PickerOption[]
  userOpts?: PickerOption[]
  usersLoading?: boolean
  usersError?: string | null
  sections?: readonly SectionKey[]
  heading?: string
  onChange: (change: PRFilterChange) => void
}

export function TaskFilterMenu({
  parsed,
  kind,
  open,
  onOpenChange,
  labelOpts,
  labelsLoading,
  labelsError,
  authorOpts,
  userOpts,
  usersLoading = false,
  usersError = null,
  sections,
  heading,
  onChange
}: TaskFilterMenuProps): React.JSX.Element {
  const t = useTranslate()
  const [openSection, setOpenSection] = useState<SectionKey | null>(null)
  const reviewerActive = parsed.reviewRequested ?? parsed.reviewedBy ?? null
  const reviewerKind: 'requested' | 'reviewed-by' = parsed.reviewedBy ? 'reviewed-by' : 'requested'
  const [reviewerModeOverride, setReviewerModeOverride] = useState<
    'requested' | 'reviewed-by' | null
  >(null)
  const reviewerMode = reviewerModeOverride ?? reviewerKind

  // Expose any non-default status as a removable pill.
  const statusActive = (parsed.state !== null && parsed.state !== 'open') || parsed.draft
  const statusPillValue = ((): string | null => {
    const parts: string[] = []
    if (parsed.state === 'closed' || parsed.state === 'merged') {
      parts.push(filterStateLabel(parsed.state, t))
    } else if (parsed.state === 'all') {
      parts.push(t('auto.components.github.PRFilterDropdowns.anyState', 'Any'))
    }
    if (parsed.draft) {
      parts.push(filterDraftLabel(t))
    }
    return parts.length > 0 ? parts.join(' · ') : null
  })()

  const activeCount =
    (statusActive ? 1 : 0) +
    (parsed.authors.length > 0 ? 1 : 0) +
    (parsed.assignee ? 1 : 0) +
    (reviewerActive ? 1 : 0) +
    (parsed.labels.length > 0 ? 1 : 0)

  const handleSelect = (change: PRFilterChange): void => {
    onChange(change)
    setOpenSection(null)
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <Popover
        open={open}
        onOpenChange={(next) => {
          onOpenChange(next)
          if (!next) {
            setOpenSection(null)
          }
        }}
      >
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className={cn(
              'h-8 gap-1.5 rounded-md border-border/60 bg-background px-2.5 text-xs font-medium text-foreground shadow-xs hover:bg-muted/60',
              activeCount > 0 && 'border-border'
            )}
          >
            <ListFilter className="size-3.5" />
            {t('auto.components.github.PRFilterDropdowns.79c54552f7', 'Filters')}
            {activeCount > 0 ? (
              <span className="ml-0.5 rounded-full bg-muted px-1.5 text-[10px] font-medium text-foreground">
                {activeCount}
              </span>
            ) : null}
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-72 p-0">
          {openSection === null ? (
            <SectionMenu
              parsed={parsed}
              kind={kind}
              reviewerActive={reviewerActive}
              reviewerKind={reviewerKind}
              onPick={(s) => {
                // Reset reviewer mode to the parsed query on each menu visit.
                if (s === 'reviewer') {
                  setReviewerModeOverride(null)
                }
                setOpenSection(s)
              }}
              onClearAll={
                activeCount > 0
                  ? () => {
                      onChange({
                        authors: [],
                        assignee: null,
                        reviewer: null,
                        labels: [],
                        state: 'open',
                        draft: false
                      })
                      setReviewerModeOverride(null)
                      onOpenChange(false)
                    }
                  : null
              }
              sections={sections}
              heading={heading}
            />
          ) : (
            <SectionDetail
              section={openSection}
              parsed={parsed}
              kind={kind}
              authorOpts={authorOpts ?? []}
              userOpts={userOpts ?? []}
              labelOpts={labelOpts}
              labelsLoading={labelsLoading}
              labelsError={labelsError}
              usersLoading={usersLoading}
              usersError={usersError}
              reviewerMode={reviewerMode}
              setReviewerMode={setReviewerModeOverride}
              onBack={() => setOpenSection(null)}
              onSelect={handleSelect}
            />
          )}
        </PopoverContent>
      </Popover>
      {statusPillValue ? (
        <ActivePill
          label={t('auto.components.github.PRFilterDropdowns.13b3ac0a84', 'Status')}
          value={statusPillValue}
          onClear={() => onChange({ state: 'open', draft: false })}
        />
      ) : null}
      {parsed.authors.length > 0 ? (
        <ActivePill
          label={t('auto.components.github.PRFilterDropdowns.01f3f3d161', 'Author')}
          value={filterAuthorsValue(parsed.authors, t) ?? ''}
          onClear={() => onChange({ authors: [] })}
        />
      ) : null}
      {parsed.labels.length > 0 ? (
        <ActivePill
          label={t('auto.components.github.PRFilterDropdowns.9d0f2eda6d', 'Label')}
          value={filterLabelsValue(parsed.labels, t) ?? ''}
          onClear={() => onChange({ labels: [] })}
        />
      ) : null}
      {reviewerActive ? (
        <ActivePill
          label={
            reviewerKind === 'reviewed-by'
              ? t('auto.components.github.PRFilterDropdowns.7f1ba66c3e', 'Reviewed by')
              : t('auto.components.github.PRFilterDropdowns.b27b7e526c', 'Review from')
          }
          value={reviewerActive}
          onClear={() => onChange({ reviewer: null })}
        />
      ) : null}
      {parsed.assignee ? (
        <ActivePill
          label={t('auto.components.github.PRFilterDropdowns.979be3cf6b', 'Assignee')}
          value={parsed.assignee}
          onClear={() => onChange({ assignee: null })}
        />
      ) : null}
    </div>
  )
}
