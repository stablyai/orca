// Why: GitHub-style PR filter UI. A single "Filters" button opens a popover
// containing Author / Label / Reviewer / Assignee sections, mirroring GitHub's
// own collapsed Filters dropdown so the toolbar stays uncluttered when nothing
// is set. Active filters surface as inline removable pills next to the button.
import React, { useMemo, useState } from 'react'
import { ListFilter, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import { useRepoLabelsBySlug, useRepoAssigneesBySlug } from '@/hooks/useGitHubSlugMetadata'
import type { PickerOption } from '@/components/github/PRFilterPickers'
import {
  SectionDetail,
  SectionMenu,
  type PRFilterChange,
  type SectionKey
} from '@/components/github/PRFilterSections'
import type {
  GitHubAssignableUser,
  GitHubOwnerRepo,
  GlobalSettings
} from '../../../../shared/types'
import type { ParsedTaskQuery } from '../../../../shared/task-query'
import { translate } from '@/i18n/i18n'

type Props = {
  parsed: ParsedTaskQuery
  kind: 'prs' | 'issues'
  authorLogins: string[]
  // Why: drive label + assignable-user lookups off the first selected repo.
  // Cross-repo filters can't enumerate every repo's labels in one popover —
  // GitHub's own PR list scopes the dropdown to a single repo too.
  primarySlug: GitHubOwnerRepo | null
  settings?: Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> | null
  onChange: (change: PRFilterChange) => void
}

export type { PRFilterChange } from '@/components/github/PRFilterSections'

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
  return (
    <span className="inline-flex h-6 items-center gap-1 rounded-full border border-border/60 bg-muted/50 pl-2 pr-1 text-[11px] text-foreground">
      <span className="text-muted-foreground">{label}:</span>
      <span className="max-w-[160px] truncate font-medium">{value}</span>
      <button
        type="button"
        aria-label={translate(
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

export default function PRFilterDropdowns({
  parsed,
  kind,
  authorLogins,
  primarySlug,
  settings,
  onChange
}: Props): React.JSX.Element {
  const [openSection, setOpenSection] = useState<SectionKey | null>(null)
  const [popoverOpen, setPopoverOpen] = useState(false)
  const owner = primarySlug?.owner ?? null
  const repo = primarySlug?.repo ?? null
  const hasPrimarySlug = popoverOpen && owner !== null && repo !== null
  const labelsState = useRepoLabelsBySlug(
    popoverOpen ? owner : null,
    popoverOpen ? repo : null,
    settings,
    primarySlug?.host
  )
  const assigneesState = useRepoAssigneesBySlug(
    popoverOpen ? owner : null,
    popoverOpen ? repo : null,
    undefined,
    settings,
    primarySlug?.host
  )

  // Why: surface @me as a first-class option even though it's not a real
  // login — GitHub's search API resolves it server-side to the authenticated
  // user, matching the behavior of the built-in "Mine" / "Needs review" presets.
  const userOpts = useMemo<PickerOption[]>(() => {
    const meOption: PickerOption = { key: '@me', primary: '@me', secondary: 'Current user' }
    return [meOption, ...userOptions(hasPrimarySlug ? assigneesState.data : [])]
  }, [assigneesState.data, hasPrimarySlug])
  const authorOpts = useMemo<PickerOption[]>(() => {
    const options = new Map<string, PickerOption>()
    options.set('@me', { key: '@me', primary: '@me', secondary: 'Current user' })
    // Why: the Author filter should reflect actual visible item authors.
    // Assignable-user metadata is repo-collaborator scoped and can omit outside
    // contributors.
    for (const login of authorLogins) {
      options.set(login.toLowerCase(), { key: login, primary: login })
    }
    if (parsed.author && !options.has(parsed.author.toLowerCase())) {
      options.set(parsed.author.toLowerCase(), { key: parsed.author, primary: parsed.author })
    }
    return [...options.values()]
  }, [authorLogins, parsed.author])
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

  // Why: treat anything other than the implicit "open" default as an active
  // status filter so the user can see (and clear) it via the inline pill.
  const statusActive = (parsed.state !== null && parsed.state !== 'open') || parsed.draft
  const statusPillValue = ((): string | null => {
    const parts: string[] = []
    if (parsed.state === 'closed') {
      parts.push('Closed')
    } else if (parsed.state === 'merged') {
      parts.push('Merged')
    } else if (parsed.state === 'all') {
      parts.push('Any')
    }
    if (parsed.draft) {
      parts.push('Draft')
    }
    return parts.length > 0 ? parts.join(' · ') : null
  })()

  const activeCount =
    (statusActive ? 1 : 0) +
    (parsed.author ? 1 : 0) +
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
        open={popoverOpen}
        onOpenChange={(next) => {
          setPopoverOpen(next)
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
              'h-7 gap-1.5 rounded-md border-border/50 px-2 text-xs font-normal',
              'bg-transparent hover:bg-muted/50',
              activeCount > 0 && 'border-border'
            )}
          >
            <ListFilter className="size-3.5" />
            {translate('auto.components.github.PRFilterDropdowns.79c54552f7', 'Filters')}
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
                // Why: each reviewer menu visit should start from the parsed
                // query unless the user toggles mode during this visit.
                if (s === 'reviewer') {
                  setReviewerModeOverride(null)
                }
                setOpenSection(s)
              }}
              onClearAll={
                activeCount > 0
                  ? () => {
                      onChange({
                        author: null,
                        assignee: null,
                        reviewer: null,
                        labels: [],
                        state: 'open',
                        draft: false
                      })
                      setReviewerModeOverride(null)
                      setPopoverOpen(false)
                    }
                  : null
              }
            />
          ) : (
            <SectionDetail
              section={openSection}
              parsed={parsed}
              kind={kind}
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
          )}
        </PopoverContent>
      </Popover>
      {statusPillValue ? (
        <ActivePill
          label={translate('auto.components.github.PRFilterDropdowns.13b3ac0a84', 'Status')}
          value={statusPillValue}
          onClear={() => onChange({ state: 'open', draft: false })}
        />
      ) : null}
      {parsed.author ? (
        <ActivePill
          label={translate('auto.components.github.PRFilterDropdowns.01f3f3d161', 'Author')}
          value={parsed.author}
          onClear={() => onChange({ author: null })}
        />
      ) : null}
      {parsed.labels.length > 0 ? (
        <ActivePill
          label={translate('auto.components.github.PRFilterDropdowns.9d0f2eda6d', 'Label')}
          value={parsed.labels.length === 1 ? parsed.labels[0] : `${parsed.labels.length} labels`}
          onClear={() => onChange({ labels: [] })}
        />
      ) : null}
      {reviewerActive ? (
        <ActivePill
          label={
            reviewerKind === 'reviewed-by'
              ? translate('auto.components.github.PRFilterDropdowns.7f1ba66c3e', 'Reviewed by')
              : translate('auto.components.github.PRFilterDropdowns.b27b7e526c', 'Review from')
          }
          value={reviewerActive}
          onClear={() => onChange({ reviewer: null })}
        />
      ) : null}
      {parsed.assignee ? (
        <ActivePill
          label={translate('auto.components.github.PRFilterDropdowns.979be3cf6b', 'Assignee')}
          value={parsed.assignee}
          onClear={() => onChange({ assignee: null })}
        />
      ) : null}
    </div>
  )
}
