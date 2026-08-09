import React, { useState } from 'react'
import { ChevronDown, GitPullRequestArrow, Plus, RefreshCw, Search } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import type { RuntimeGitLocalBranches } from '../../../../shared/runtime-types'
import type { SourceControlViewMode } from '../../../../shared/types'
import type { LocalizedHostedReviewCopy } from '@/i18n/hosted-review-localized-copy'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { SourceControlHeaderOverflowMenu } from './source-control-header-overflow-menu'

/** Renders a searchable branch switcher for a folder-scope repo. */
function BranchSwitcher({
  branch,
  branches,
  disabled,
  onSwitch
}: {
  branch: string | null | undefined
  branches: RuntimeGitLocalBranches | null
  disabled: boolean
  onSwitch: (branch: string) => void
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const filtered = (branches?.branches ?? []).filter((item) =>
    item.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())
  )

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="inline-flex h-6 min-w-0 max-w-[150px] items-center gap-1 rounded border border-border bg-background px-1.5 text-[11px] text-foreground"
          disabled={disabled}
          aria-label={translate(
            'auto.components.right.sidebar.SourceControl.b1a4f0c7d2',
            'Switch branch'
          )}
        >
          <span className="min-w-0 flex-1 truncate">
            {branch ??
              translate('auto.components.right.sidebar.SourceControl.5c2f9ab310', 'No branch')}
          </span>
          <ChevronDown className="size-3 shrink-0 text-muted-foreground" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" sideOffset={4} className="w-56 p-1">
        <label className="flex h-7 items-center gap-1 rounded border border-border bg-background px-1.5">
          <Search className="size-3 shrink-0 text-muted-foreground" />
          <input
            className="min-w-0 flex-1 bg-transparent text-[11px] outline-none placeholder:text-muted-foreground/60"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={translate(
              'auto.components.settings.BaseRefPicker.7db7fb87e5',
              'Search branches by name...'
            )}
          />
        </label>
        <div className="mt-1 max-h-[220px] overflow-y-auto scrollbar-sleek">
          {filtered.map((item) => (
            <button
              key={item}
              type="button"
              className="block w-full truncate rounded-sm px-2 py-1 text-left text-[11px] hover:bg-accent/60"
              onClick={() => {
                setOpen(false)
                setQuery('')
                onSwitch(item)
              }}
            >
              {item}
            </button>
          ))}
          {filtered.length === 0 ? (
            <div className="px-2 py-1 text-[11px] text-muted-foreground">
              {translate(
                'auto.components.settings.BaseRefPicker.1b8e54151f',
                'No matching branches.'
              )}
            </div>
          ) : null}
        </div>
      </PopoverContent>
    </Popover>
  )
}

/** Renders the folder source-control toolbar and commit input. */
export function FolderSourceControlToolbar({
  branch,
  branches,
  branchSwitching,
  onSwitchBranch,
  onStageAll,
  stageAllBusy,
  onCreatePr,
  filterQuery,
  onFilterQueryChange,
  viewMode,
  onToggleViewMode,
  onChangeBaseRef,
  onRefreshBranchCompare,
  branchCompareRefreshing,
  reviewCopy
}: {
  branch: string | null | undefined
  branches: RuntimeGitLocalBranches | null
  branchSwitching: boolean
  onSwitchBranch: (branch: string) => void
  onStageAll: () => void
  stageAllBusy: boolean
  onCreatePr: () => void
  filterQuery: string
  onFilterQueryChange: (value: string) => void
  viewMode: SourceControlViewMode
  onToggleViewMode: () => void
  onChangeBaseRef: () => void
  onRefreshBranchCompare: () => void
  branchCompareRefreshing: boolean
  reviewCopy: LocalizedHostedReviewCopy
}): React.JSX.Element {
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1.5 px-3 py-1.5 text-xs text-muted-foreground">
      <BranchSwitcher
        branch={branch}
        branches={branches}
        disabled={branchSwitching || !branches}
        onSwitch={onSwitchBranch}
      />
      <button
        type="button"
        className="inline-flex h-6 shrink-0 items-center gap-1 rounded border border-border bg-background px-1.5 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground"
        onClick={onStageAll}
        disabled={stageAllBusy}
      >
        <Plus className="size-3" />
        {translate('auto.components.right.sidebar.SourceControl.24d2598eff', 'Stage all')}
      </button>
      <button
        type="button"
        className="inline-flex h-6 shrink-0 items-center gap-1 rounded border border-transparent bg-foreground px-1.5 text-[11px] text-background hover:bg-foreground/90"
        onClick={onCreatePr}
      >
        <GitPullRequestArrow className="size-3" />
        {translate(
          'auto.components.right.sidebar.source.control.primary.action.e7ffa46946',
          'Create {{value0}}',
          { value0: reviewCopy.shortLabel }
        )}
      </button>
      <label className="flex h-6 min-w-0 max-w-[130px] shrink items-center gap-1 rounded border border-border bg-background px-1.5">
        <Search className="size-3 shrink-0 text-muted-foreground" />
        <input
          className="min-w-0 flex-1 bg-transparent text-[11px] outline-none placeholder:text-muted-foreground/60"
          value={filterQuery}
          onChange={(event) => onFilterQueryChange(event.target.value)}
          placeholder={translate(
            'auto.components.right.sidebar.SourceControl.b3c8f1a902',
            'Filter files by name'
          )}
        />
      </label>
      <button
        type="button"
        className="inline-flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
        onClick={onRefreshBranchCompare}
        disabled={branchCompareRefreshing}
        aria-label={translate(
          'auto.components.right.sidebar.GitHistoryPanel.d0fb0f4bf2',
          'Refresh commits'
        )}
      >
        <RefreshCw className="size-3.5" />
      </button>
      <SourceControlHeaderOverflowMenu
        sourceControlViewMode={viewMode}
        viewModeToggleDisabled={false}
        onToggleViewMode={onToggleViewMode}
        onChangeBaseRef={onChangeBaseRef}
        onRefreshBranchCompare={onRefreshBranchCompare}
        branchCompareRefreshDisabled={branchCompareRefreshing}
        diffCommentCount={0}
        onExpandNotes={() => {}}
      />
    </div>
  )
}

/** Renders the commit message input and submit button. */
export function FolderCommitArea({
  value,
  onChange,
  onCommit,
  busy,
  error
}: {
  value: string
  onChange: (value: string) => void
  onCommit: () => void
  busy: boolean
  error: string | null
}): React.JSX.Element {
  return (
    <div className="space-y-1 px-3 py-1">
      <textarea
        className="min-h-[56px] w-full resize-y rounded-md border border-border bg-background px-2 py-1 text-xs outline-none placeholder:text-muted-foreground/60"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={translate(
          'auto.components.right.sidebar.source.control.primary.action.f01f16d77f',
          'Enter a commit message to commit'
        )}
      />
      <div className="flex min-w-0 items-center gap-2">
        <button
          type="button"
          className="inline-flex h-6 shrink-0 items-center gap-1 rounded border border-border bg-background px-2 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50"
          onClick={onCommit}
          disabled={busy || value.trim().length === 0}
        >
          {translate(
            'auto.components.right.sidebar.source.control.primary.action.ed93b4f14f',
            'Commit'
          )}
        </button>
        {error ? <span className="truncate text-[11px] text-destructive">{error}</span> : null}
      </div>
    </div>
  )
}

/** Renders the inline editor for a scanned repo's base ref. */
export function FolderBaseRefEditor({
  value,
  onApply
}: {
  value: string
  onApply: (value: string) => void
}): React.JSX.Element {
  /** Applies a trimmed base ref when it differs from the current value. */
  function applyIfChanged(next: string): void {
    const trimmed = next.trim()
    if (trimmed.length === 0 || trimmed === value.trim()) {
      return
    }
    onApply(trimmed)
  }
  return (
    <div className="flex items-center gap-1 px-3 pb-1">
      <input
        className="h-6 min-w-0 flex-1 rounded border border-border bg-background px-1.5 text-[11px] outline-none"
        key={value}
        defaultValue={value}
        placeholder={translate(
          'auto.components.right.sidebar.SourceControl.476b77745b',
          'Change Base Ref'
        )}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            applyIfChanged((event.target as HTMLInputElement).value)
          }
        }}
        onBlur={(event) => applyIfChanged(event.target.value)}
      />
    </div>
  )
}

/** Explains why creating a review requires a clean working tree. */
export function CreateReviewBlockedNotice({
  reviewLabel
}: {
  reviewLabel: string
}): React.JSX.Element {
  return (
    <div className="mx-3 mb-1 rounded-md border border-destructive/30 bg-destructive/5 px-2 py-1 text-[11px] text-destructive">
      <div className="font-medium">
        {translate(
          'auto.components.right.sidebar.checks.panel.review.dirty.title',
          'Commit changes first'
        )}
      </div>
      <div className="text-destructive/80">
        {translate(
          'auto.components.right.sidebar.checks.panel.review.dirty.body',
          'Commit or stash your changes before creating a {{reviewLabel}}.',
          { reviewLabel }
        )}
      </div>
    </div>
  )
}
