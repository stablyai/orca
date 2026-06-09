import React from 'react'
import { ChevronRight } from 'lucide-react'
import {
  MultiSelectList,
  SingleSelectList,
  type PickerOption
} from '@/components/github/PRFilterPickers'
import { cn } from '@/lib/utils'
import type { ParsedTaskQuery } from '../../../../shared/task-query'
import { translate } from '@/i18n/i18n'

export type PRFilterChange = {
  author?: string | null
  assignee?: string | null
  reviewer?: { kind: 'requested' | 'reviewed-by'; login: string } | null
  labels?: string[]
  state?: 'open' | 'closed' | 'merged' | 'all'
  draft?: boolean
}

export type SectionKey = 'status' | 'author' | 'label' | 'reviewer' | 'assignee'

function statusLabel(parsed: ParsedTaskQuery): string {
  const parts: string[] = []
  if (parsed.state === 'open') {
    parts.push('Open')
  } else if (parsed.state === 'closed') {
    parts.push('Closed')
  } else if (parsed.state === 'merged') {
    parts.push('Merged')
  } else if (parsed.state === 'all') {
    parts.push('All')
  }
  if (parsed.draft) {
    parts.push('Draft')
  }
  return parts.join(' · ')
}

function StatusSection({
  parsed,
  kind,
  onSelect
}: {
  parsed: ParsedTaskQuery
  kind: 'prs' | 'issues'
  onSelect: (change: PRFilterChange) => void
}): React.JSX.Element {
  const states: { key: 'open' | 'closed' | 'merged' | 'all'; label: string }[] =
    kind === 'prs'
      ? [
          { key: 'open', label: translate("auto.components.github.PRFilterSections.d78b60b5c2", "Open") },
          { key: 'closed', label: translate("auto.components.github.PRFilterSections.0fd3249e2e", "Closed") },
          { key: 'merged', label: translate("auto.components.github.PRFilterSections.bd162b7d5a", "Merged") },
          { key: 'all', label: translate("auto.components.github.PRFilterSections.2b2f019091", "Any state") }
        ]
      : [
          { key: 'open', label: translate("auto.components.github.PRFilterSections.d78b60b5c2", "Open") },
          { key: 'closed', label: translate("auto.components.github.PRFilterSections.0fd3249e2e", "Closed") },
          { key: 'all', label: translate("auto.components.github.PRFilterSections.2b2f019091", "Any state") }
        ]
  return (
    <div className="py-1 text-xs">
      {states.map((s) => {
        const active = parsed.state === s.key
        return (
          <button
            key={s.key}
            type="button"
            onClick={() => onSelect({ state: s.key })}
            className={cn(
              'flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left transition hover:bg-muted/50',
              active && 'bg-muted/40 font-medium'
            )}
          >
            <span>{s.label}</span>
            {active ? <span className="text-[10px] text-muted-foreground">{translate("auto.components.github.PRFilterSections.e0002f1eba", "selected")}</span> : null}
          </button>
        )
      })}
      {kind !== "prs" ? null : <DraftToggle parsed={parsed} onSelect={onSelect} />}
    </div>
  )
}

function DraftToggle({
  parsed,
  onSelect
}: {
  parsed: ParsedTaskQuery
  onSelect: (change: PRFilterChange) => void
}): React.JSX.Element {
  return (
    <>
      <div className="my-1 h-px bg-border" />
      <button
        type="button"
        onClick={() => onSelect({ draft: !parsed.draft })}
        className={cn(
          'flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left transition hover:bg-muted/50',
          parsed.draft && 'bg-muted/40 font-medium'
        )}
      >
        <span>{translate("auto.components.github.PRFilterSections.b930de7194", "Draft only")}</span>
        {parsed.draft ? (
          <span className="text-[10px] text-muted-foreground">{translate("auto.components.github.PRFilterSections.1e9b5244f2", "on")}</span>
        ) : (
          <span className="text-[10px] text-muted-foreground">{translate("auto.components.github.PRFilterSections.f0cf6dd591", "off")}</span>
        )}
      </button>
    </>
  )
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
  const status = statusLabel(parsed)
  const rows: { key: SectionKey; label: string; value: string | null }[] = [
    { key: 'status', label: translate("auto.components.github.PRFilterSections.764a0b4ce1", "Status"), value: status || null },
    { key: 'author', label: translate("auto.components.github.PRFilterSections.24754c44ad", "Author"), value: parsed.author },
    {
      key: 'label',
      label: translate("auto.components.github.PRFilterSections.b1d9fdea08", "Label"),
      value:
        parsed.labels.length === 0
          ? null
          : parsed.labels.length === 1
            ? parsed.labels[0]
            : `${parsed.labels.length} labels`
    },
    ...(kind === 'prs'
      ? [
          {
            key: 'reviewer' as SectionKey,
            label: reviewerKind === 'reviewed-by' ? 'Reviewed by' : 'Review from',
            value: reviewerActive
          }
        ]
      : []),
    { key: 'assignee', label: translate("auto.components.github.PRFilterSections.ea3416d646", "Assignee"), value: parsed.assignee }
  ]
  const subject = kind === 'prs' ? 'pull requests' : 'issues'
  return (
    <div className="py-1 text-xs">
      <div className="px-3 py-1.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
        {translate("auto.components.github.PRFilterSections.8177eda37e", "Filter")}{subject}
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
            {translate("auto.components.github.PRFilterSections.30ebb6ca44", "Clear all filters")}</button>
        </>
      ) : null}
    </div>
  )
}

export function SectionDetail({
  section,
  parsed,
  kind,
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
  kind: 'prs' | 'issues'
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
  return (
    <div>
      <button
        type="button"
        onClick={onBack}
        className="flex w-full items-center gap-1 border-b border-border px-3 py-1.5 text-[11px] text-muted-foreground transition hover:bg-muted/50 hover:text-foreground"
      >
        <ChevronRight className="size-3 rotate-180" />
        {translate("auto.components.github.PRFilterSections.b69fa4fa20", "Back")}</button>
      {section === "status" ? (
        <StatusSection parsed={parsed} kind={kind} onSelect={onSelect} />
      ) : null}
      {section === "author" ? (
        <SingleSelectList
          options={authorOpts}
          activeValue={parsed.author}
          loading={false}
          error={null}
          searchPlaceholder="Filter or type a login..."
          emptyText={translate("auto.components.github.PRFilterSections.458ea3602b", "No authors")}
          allowCustomValue
          renderOption={(opt) => <UserOptionRow option={opt} />}
          onSelect={(value) => onSelect({ author: value })}
        />
      ) : null}
      {section === "assignee" ? (
        <SingleSelectList
          options={userOpts}
          activeValue={parsed.assignee}
          loading={usersLoading}
          error={usersError}
          searchPlaceholder="Filter or type a login..."
          emptyText={translate("auto.components.github.PRFilterSections.a00830d3f7", "No users")}
          allowCustomValue
          renderOption={(opt) => <UserOptionRow option={opt} />}
          onSelect={(value) => onSelect({ assignee: value })}
        />
      ) : null}
      {section === "label" ? (
        <MultiSelectList
          options={labelOpts}
          selected={parsed.labels}
          loading={labelsLoading}
          error={labelsError}
          searchPlaceholder="Filter labels..."
          emptyText={translate("auto.components.github.PRFilterSections.de26e2eb06", "No labels")}
          onChange={(next) => onSelect({ labels: next })}
        />
      ) : null}
      {section === "reviewer" ? (
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
              {translate("auto.components.github.PRFilterSections.94b42b0edf", "Review requested")}</button>
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
              {translate("auto.components.github.PRFilterSections.0103e1cb18", "Reviewed by")}</button>
          </div>
          <SingleSelectList
            options={userOpts}
            activeValue={reviewerMode === 'requested' ? parsed.reviewRequested : parsed.reviewedBy}
            loading={usersLoading}
            error={usersError}
            searchPlaceholder="Filter or type a login..."
            emptyText={translate("auto.components.github.PRFilterSections.a00830d3f7", "No users")}
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
