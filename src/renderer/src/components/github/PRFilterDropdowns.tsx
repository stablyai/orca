import React, { useEffect, useMemo, useRef, useState } from 'react'
import { X } from 'lucide-react'
import { RailPageFilterButton } from '@/components/rail-page/RailPageToolbar'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  useRepoLabelsBySlug,
  useRepoAssigneesBySlug
} from '@/lib/work-items/github/useGitHubSlugMetadata'
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
import { PRFilterValueMenu } from '@/components/github/PRFilterValueMenu'
import type { GitHubAssignableUser } from '../../../../shared/github/pull-requests/pull-request-types'
import type { GitHubRepositoryIdentity as GitHubOwnerRepo } from '../../../../shared/github/repositories/repository-identity'
import type { RuntimeClientTarget } from '../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import type { TaskViewPresetId } from '../../../../shared/ui-chrome/ui-chrome-types'
import type { ParsedTaskQuery } from '../../../../shared/work-items/task-query'
import { translate } from '@/i18n/i18n'
import { useTranslate, type Translate } from '@/i18n/use-translate'

type Props = {
  parsed: ParsedTaskQuery
  defaultFilters: ParsedTaskQuery
  activeCount: number
  presets?: React.ReactNode
  kind: 'prs' | 'issues'
  authorLogins: string[]
  // Scope metadata to the first selected repo; one popover cannot enumerate every repo’s labels and users.
  primarySlug: GitHubOwnerRepo | null
  /** Host that owns the repo the primary slug came from. */
  ownerTarget?: RuntimeClientTarget | null
  onChange: (change: PRFilterChange) => void
  onSetDefaultPreset?: (preset: TaskViewPresetId) => void
}

export type { PRFilterChange } from '@/components/github/PRFilterSections'

function currentUserLabel(t: Translate = translate): string {
  return t('auto.components.github.PRFilterDropdowns.currentUser', 'Current user')
}

function userOptions(users: GitHubAssignableUser[]): PickerOption[] {
  return users.map((u) => ({ key: u.login, primary: u.login, secondary: u.name ?? undefined }))
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

const DRILL_IN_FOCUSABLE_SELECTOR =
  'button:not(:disabled), input:not(:disabled), [tabindex]:not([tabindex="-1"])'

function cycleDrillInFocus(container: HTMLElement | null, reverse: boolean): void {
  if (!container) {
    return
  }
  const focusables = Array.from(
    container.querySelectorAll<HTMLElement>(DRILL_IN_FOCUSABLE_SELECTOR)
  ).filter((el) => el.offsetParent !== null)
  if (focusables.length === 0) {
    return
  }
  const activeIndex = focusables.findIndex(
    (el) => el === document.activeElement || el.contains(document.activeElement)
  )
  const nextIndex =
    activeIndex === -1
      ? reverse
        ? focusables.length - 1
        : 0
      : (activeIndex + (reverse ? -1 : 1) + focusables.length) % focusables.length
  focusables[nextIndex]?.focus()
}

export default function PRFilterDropdowns({
  parsed,
  defaultFilters,
  activeCount,
  presets,
  kind,
  authorLogins,
  primarySlug,
  ownerTarget,
  onChange,
  onSetDefaultPreset
}: Props): React.JSX.Element {
  const [openSection, setOpenSection] = useState<SectionKey | null>(null)
  const [popoverOpen, setPopoverOpen] = useState(false)
  const drillInRef = useRef<HTMLDivElement>(null)
  // Each author pick reloads the list, so keep the authors visible at open as candidates.
  const [authorLoginsAtOpen, setAuthorLoginsAtOpen] = useState<string[]>([])

  useEffect(() => {
    if (kind !== 'prs' || !popoverOpen || openSection === null) {
      return
    }
    const frame = requestAnimationFrame(() => {
      drillInRef.current
        ?.querySelector<HTMLInputElement>('[cmdk-input]:not(:disabled)')
        ?.focus({ preventScroll: true })
    })
    return () => cancelAnimationFrame(frame)
  }, [kind, popoverOpen, openSection])
  const owner = primarySlug?.owner ?? null
  const repo = primarySlug?.repo ?? null
  const hasPrimarySlug = popoverOpen && owner !== null && repo !== null
  const labelsState = useRepoLabelsBySlug(
    popoverOpen ? owner : null,
    popoverOpen ? repo : null,
    ownerTarget,
    primarySlug?.host
  )
  const assigneesState = useRepoAssigneesBySlug(
    popoverOpen ? owner : null,
    popoverOpen ? repo : null,
    undefined,
    ownerTarget,
    primarySlug?.host
  )

  // Offer @me because GitHub resolves it server-side to the authenticated user.
  const userOpts = useMemo<PickerOption[]>(() => {
    const meOption: PickerOption = {
      key: '@me',
      primary: '@me',
      secondary: currentUserLabel()
    }
    return [meOption, ...userOptions(hasPrimarySlug ? assigneesState.data : [])]
  }, [assigneesState.data, hasPrimarySlug])
  const authorOpts = useMemo<PickerOption[]>(() => {
    const options = new Map<string, PickerOption>()
    options.set('@me', {
      key: '@me',
      primary: '@me',
      secondary: currentUserLabel()
    })
    // Use visible authors because assignable-user metadata excludes outside contributors.
    for (const login of [...authorLoginsAtOpen, ...authorLogins]) {
      options.set(login.toLowerCase(), { key: login, primary: login })
    }
    // Key options by the query's casing so the picker's selection matches them.
    for (const author of parsed.authors) {
      const lower = author.toLowerCase()
      options.set(lower, { ...(options.get(lower) ?? { primary: author }), key: author })
    }
    return [...options.values()]
  }, [authorLoginsAtOpen, authorLogins, parsed.authors])
  const labelOpts = useMemo<PickerOption[]>(
    () => (hasPrimarySlug ? labelsState.data.map((name) => ({ key: name, primary: name })) : []),
    [hasPrimarySlug, labelsState.data]
  )

  const reviewerActive = parsed.reviewRequested ?? parsed.reviewedBy ?? null
  const reviewerKind: 'requested' | 'reviewed-by' = parsed.reviewedBy ? 'reviewed-by' : 'requested'
  const [reviewerModeOverride, setReviewerModeOverride] = useState<
    'requested' | 'reviewed-by' | null
  >(null)
  const reviewerMode = reviewerModeOverride ?? reviewerKind

  const handleSelect = (change: PRFilterChange): void => {
    onChange(change)
    setOpenSection(null)
  }

  const handleOpenChange = (next: boolean): void => {
    setPopoverOpen(next)
    if (next) {
      setAuthorLoginsAtOpen(authorLogins)
    } else {
      setOpenSection(null)
    }
  }

  const handlePickSection = (s: SectionKey): void => {
    // Reset reviewer mode to the parsed query on each menu visit.
    if (s === 'reviewer') {
      setReviewerModeOverride(null)
    }
    setOpenSection(s)
  }

  const clearAll =
    activeCount > 0
      ? () => {
          onChange({
            authors: defaultFilters.authors,
            assignee: defaultFilters.assignee,
            reviewer: getReviewer(defaultFilters),
            labels: defaultFilters.labels,
            state: defaultFilters.state ?? 'all',
            draft: defaultFilters.draft
          })
          setReviewerModeOverride(null)
          setPopoverOpen(false)
        }
      : null

  const sectionDetail =
    openSection !== null ? (
      <SectionDetail
        section={openSection}
        parsed={parsed}
        authorOpts={authorOpts}
        userOpts={userOpts}
        labelOpts={labelOpts}
        labelsLoading={hasPrimarySlug && labelsState.loading}
        labelsError={hasPrimarySlug ? labelsState.error : null}
        usersLoading={hasPrimarySlug && assigneesState.loading}
        usersError={hasPrimarySlug ? assigneesState.error : null}
        reviewerMode={reviewerMode}
        setReviewerMode={setReviewerModeOverride}
        onBack={() => setOpenSection(null)}
        onSelect={handleSelect}
      />
    ) : null

  if (kind === 'prs') {
    return (
      <DropdownMenu open={popoverOpen} onOpenChange={handleOpenChange}>
        <DropdownMenuTrigger asChild>
          <RailPageFilterButton activeCount={activeCount} />
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          density="comfortable"
          variant={openSection ? 'picker' : 'default'}
          className="w-[300px] max-w-(--radix-dropdown-menu-content-available-width)"
        >
          {openSection === null ? (
            <PRFilterValueMenu
              parsed={parsed}
              reviewerActive={reviewerActive}
              reviewerKind={reviewerKind}
              onChange={onChange}
              onPick={handlePickSection}
              onClearAll={clearAll}
              onSetDefaultPreset={onSetDefaultPreset}
            />
          ) : (
            <div
              ref={drillInRef}
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  return
                }
                if (event.key === 'Tab') {
                  // Radix DropdownMenu calls preventDefault() on Tab; manage drill-in focus order directly.
                  event.preventDefault()
                  event.stopPropagation()
                  cycleDrillInFocus(drillInRef.current, event.shiftKey)
                  return
                }
                // Keep Command search typing and arrow navigation out of Radix menu typeahead.
                event.stopPropagation()
              }}
            >
              {sectionDetail}
            </div>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    )
  }

  return (
    <Popover open={popoverOpen} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <RailPageFilterButton activeCount={activeCount} />
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 max-w-(--radix-popover-content-available-width)">
        {openSection === null ? (
          <>
            {presets}
            <SectionMenu
              parsed={parsed}
              kind={kind}
              reviewerActive={reviewerActive}
              reviewerKind={reviewerKind}
              onPick={handlePickSection}
              onClearAll={clearAll}
            />
          </>
        ) : (
          sectionDetail
        )}
      </PopoverContent>
    </Popover>
  )
}

type FilterPill = {
  key: string
  label: string
  value: string | null
  reset: PRFilterChange
}

function getReviewer(query: ParsedTaskQuery): PRFilterChange['reviewer'] {
  if (query.reviewedBy) {
    return { kind: 'reviewed-by', login: query.reviewedBy }
  }
  return query.reviewRequested ? { kind: 'requested', login: query.reviewRequested } : null
}

function sameValues(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value) => right.includes(value))
}

export function getPRFilterPills(
  parsed: ParsedTaskQuery,
  base: ParsedTaskQuery,
  t: Translate
): FilterPill[] {
  const pills: FilterPill[] = []
  const state = parsed.state ?? 'all'
  const baseState = base.state ?? 'all'
  const reviewer = getReviewer(parsed)
  const baseReviewer = getReviewer(base)
  const stateLabel =
    state === 'all'
      ? t('auto.components.github.PRFilterDropdowns.anyState', 'Any')
      : filterStateLabel(state, t)
  if (state !== baseState || parsed.draft !== base.draft) {
    pills.push({
      key: 'status',
      label: t('auto.components.github.PRFilterDropdowns.13b3ac0a84', 'Status'),
      value: parsed.draft ? `${stateLabel} · ${filterDraftLabel(t)}` : stateLabel,
      reset: { state: baseState, draft: base.draft }
    })
  }
  if (!sameValues(parsed.authors, base.authors)) {
    pills.push({
      key: 'author',
      label: t('auto.components.github.PRFilterDropdowns.01f3f3d161', 'Author'),
      value: filterAuthorsValue(parsed.authors, t),
      reset: { authors: base.authors }
    })
  }
  if (!sameValues(parsed.labels, base.labels)) {
    pills.push({
      key: 'label',
      label: t('auto.components.github.PRFilterDropdowns.9d0f2eda6d', 'Label'),
      value: filterLabelsValue(parsed.labels, t),
      reset: { labels: base.labels }
    })
  }
  if (reviewer?.kind !== baseReviewer?.kind || reviewer?.login !== baseReviewer?.login) {
    pills.push({
      key: 'reviewer',
      label:
        (reviewer ?? baseReviewer)?.kind === 'reviewed-by'
          ? t('auto.components.github.PRFilterDropdowns.7f1ba66c3e', 'Reviewed by')
          : t('auto.components.github.PRFilterDropdowns.b27b7e526c', 'Review from'),
      value: reviewer?.login ?? null,
      reset: { reviewer: baseReviewer }
    })
  }
  if (parsed.assignee !== base.assignee) {
    pills.push({
      key: 'assignee',
      label: t('auto.components.github.PRFilterDropdowns.979be3cf6b', 'Assignee'),
      value: parsed.assignee,
      reset: { assignee: base.assignee }
    })
  }
  return pills
}

export function PRFilterPills({
  pills,
  onChange
}: {
  pills: readonly FilterPill[]
  onChange: Props['onChange']
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <div className="flex flex-wrap gap-1.5">
      {pills.map(({ key, label, value, reset }) => (
        <ActivePill
          key={key}
          label={label}
          value={value ?? t('auto.components.github.PRFilterDropdowns.anyState', 'Any')}
          onClear={() => onChange(reset)}
        />
      ))}
    </div>
  )
}
