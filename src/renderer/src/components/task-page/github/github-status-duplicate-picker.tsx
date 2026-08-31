import React, { useCallback } from 'react'
import { CheckCircle2, ChevronLeft, CircleDot, Copy, Search } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  getTaskPageGitHubDuplicateTargetErrorMessage,
  validateTaskPageGitHubDuplicateTarget,
  type TaskPageGitHubCloseAction
} from '@/components/task-page-github-status-actions'
import { translate } from '@/i18n/i18n'
import type { GitHubWorkItem } from '../../../../../shared/github/work-item-types'

export function GitHubStatusDuplicatePicker({
  item,
  title,
  duplicateSearch,
  setDuplicateSearch,
  duplicateError,
  setDuplicateError,
  filteredDuplicateCandidates,
  directDuplicateTarget,
  setDuplicatePickerOpen,
  setOpen,
  handleStateChange
}: {
  item: GitHubWorkItem
  title: string
  duplicateSearch: string
  setDuplicateSearch: (value: string) => void
  duplicateError: string | null
  setDuplicateError: (value: string | null) => void
  filteredDuplicateCandidates: GitHubWorkItem[]
  directDuplicateTarget: number | null
  setDuplicatePickerOpen: (open: boolean) => void
  setOpen: (open: boolean) => void
  handleStateChange: (newState: 'open' | 'closed', closeAction?: TaskPageGitHubCloseAction) => void
}): React.JSX.Element {
  const closeAsDuplicate = useCallback(
    (targetIssueNumber: number | string) => {
      const validation = validateTaskPageGitHubDuplicateTarget(
        String(targetIssueNumber),
        item.number
      )
      if (!validation.ok) {
        setDuplicateError(getTaskPageGitHubDuplicateTargetErrorMessage(validation, translate))
        return
      }
      setDuplicateError(null)
      handleStateChange('closed', { stateReason: 'duplicate', duplicateOf: validation.duplicateOf })
      setOpen(false)
      setDuplicatePickerOpen(false)
    },
    [handleStateChange, item.number, setDuplicateError, setOpen, setDuplicatePickerOpen]
  )

  const handleDuplicateSearchSubmit = useCallback(() => {
    const validation = validateTaskPageGitHubDuplicateTarget(duplicateSearch, item.number)
    if (!validation.ok) {
      setDuplicateError(getTaskPageGitHubDuplicateTargetErrorMessage(validation, translate))
      return
    }
    closeAsDuplicate(validation.duplicateOf)
  }, [closeAsDuplicate, duplicateSearch, item.number, setDuplicateError])

  return (
    <div>
      <div className="flex items-center gap-2 px-1 py-1.5">
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          className="size-7"
          onClick={() => {
            setDuplicatePickerOpen(false)
            setDuplicateSearch('')
            setDuplicateError(null)
          }}
          aria-label={translate('auto.components.TaskPage.backToCloseReasons', 'Back')}
        >
          <ChevronLeft className="size-4" />
        </Button>
        <span className="min-w-0 truncate text-[12px] font-semibold">{title}</span>
      </div>
      <div className="relative px-1 pb-2">
        <Search className="pointer-events-none absolute left-3 top-2.5 size-4 text-muted-foreground" />
        <Input
          autoFocus
          value={duplicateSearch}
          onChange={(event) => {
            setDuplicateSearch(event.target.value)
            setDuplicateError(null)
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              handleDuplicateSearchSubmit()
            }
          }}
          placeholder={translate('auto.components.TaskPage.searchIssues', 'Search issues')}
          className="h-9 pl-8 text-[12px]"
          aria-invalid={duplicateError ? true : undefined}
          aria-describedby={duplicateError ? 'github-duplicate-picker-error' : undefined}
        />
      </div>
      {duplicateError ? (
        <p id="github-duplicate-picker-error" className="px-2 pb-2 text-[11px] text-destructive">
          {duplicateError}
        </p>
      ) : null}
      <div className="scrollbar-sleek max-h-72 overflow-y-auto pr-1">
        {directDuplicateTarget ? (
          <button
            type="button"
            onClick={() => closeAsDuplicate(directDuplicateTarget)}
            className="flex w-full items-center gap-2 rounded-sm px-2 py-2 text-left hover:bg-accent"
          >
            <Copy className="size-4 text-primary" />
            <span className="min-w-0 flex-1 text-[12px] font-medium">
              {translate('auto.components.TaskPage.useIssueNumber', 'Use issue #{{value0}}', {
                value0: directDuplicateTarget
              })}
            </span>
          </button>
        ) : null}
        {filteredDuplicateCandidates.map((candidate) => (
          <button
            key={`${candidate.repoId}:${candidate.number}`}
            type="button"
            onClick={() => closeAsDuplicate(candidate.number)}
            className="flex w-full items-start gap-2 rounded-sm px-2 py-2 text-left hover:bg-accent"
          >
            {candidate.state === 'closed' ? (
              <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-primary" />
            ) : (
              <CircleDot className="mt-0.5 size-4 shrink-0 text-emerald-500" />
            )}
            <span className="min-w-0 flex-1">
              <span className="block text-[12px] font-medium leading-snug">{candidate.title}</span>
            </span>
            <span className="shrink-0 text-[12px] text-muted-foreground">#{candidate.number}</span>
          </button>
        ))}
        {!directDuplicateTarget && filteredDuplicateCandidates.length === 0 ? (
          <p className="px-2 py-3 text-[12px] text-muted-foreground">
            {translate(
              'auto.components.TaskPage.noMatchingIssuesLoaded',
              'No matching issues loaded.'
            )}
          </p>
        ) : null}
      </div>
    </div>
  )
}
