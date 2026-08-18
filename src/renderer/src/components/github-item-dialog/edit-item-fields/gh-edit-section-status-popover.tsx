import React from 'react'
import {
  Ban,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleDashed,
  CircleDot,
  Copy,
  Search
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import type { GitHubWorkItem } from '../../../../../shared/github/work-item-types'
import type { TaskPageGitHubCloseAction } from '@/components/task-page-github-status-actions'
import { getStateLabel } from '@/components/github/work-item-state-presentation'
import { translate } from '@/i18n/i18n'
import { getStateTone } from '../load-item-details/work-item-state-badge'

export function GHEditSectionStatusPopover({
  item,
  variant,
  localState,
  isPending,
  statusPopoverOpen,
  duplicatePickerOpen,
  duplicateSearch,
  duplicateError,
  duplicatePickerTitle,
  filteredDuplicateCandidates,
  directDuplicateTarget,
  onOpenChange,
  onStateChange,
  onDuplicateSearchChange,
  onDuplicateSearchSubmit,
  onCloseAsDuplicate,
  onBackFromDuplicate,
  onOpenDuplicatePicker
}: {
  item: GitHubWorkItem
  variant: 'sidebar' | 'pill'
  localState: GitHubWorkItem['state']
  isPending: boolean
  statusPopoverOpen: boolean
  duplicatePickerOpen: boolean
  duplicateSearch: string
  duplicateError: string | null
  duplicatePickerTitle: string
  filteredDuplicateCandidates: GitHubWorkItem[]
  directDuplicateTarget: number | null
  onOpenChange: (open: boolean) => void
  onStateChange: (newState: 'open' | 'closed', closeAction?: TaskPageGitHubCloseAction) => void
  onDuplicateSearchChange: (value: string) => void
  onDuplicateSearchSubmit: () => void
  onCloseAsDuplicate: (targetIssueNumber: number | string) => void
  onBackFromDuplicate: () => void
  onOpenDuplicatePicker: () => void
}): React.JSX.Element {
  const isSidebar = variant === 'sidebar'
  return (
    <Popover open={statusPopoverOpen} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={isPending}
          className={cn(
            isSidebar
              ? 'inline-flex w-full items-center justify-between gap-2 rounded-md border px-2.5 py-1.5 text-[12px] font-medium transition hover:brightness-125 hover:ring-1 hover:ring-white/10 disabled:opacity-50'
              : 'group/status inline-flex items-center gap-0.5 rounded-full border px-2 py-0.5 text-[11px] font-medium transition hover:brightness-125 hover:ring-1 hover:ring-white/10 disabled:opacity-50',
            localState === 'closed'
              ? getStateTone({ ...item, state: localState })
              : 'border-border/60 bg-muted/20 text-foreground hover:bg-accent/60'
          )}
        >
          <span className="inline-flex items-center gap-1.5">
            {localState === 'closed' ? (
              <CircleDashed className={isSidebar ? 'size-3.5' : 'size-3'} />
            ) : (
              <CircleDot className={cn(isSidebar ? 'size-3.5' : 'size-3', 'text-emerald-500')} />
            )}
            {getStateLabel({ ...item, state: localState })}
          </span>
          <ChevronDown className={isSidebar ? 'size-3 opacity-60' : 'size-2.5 opacity-50'} />
        </button>
      </PopoverTrigger>
      <PopoverContent
        className={cn(duplicatePickerOpen ? 'w-[360px]' : 'w-56', 'p-1')}
        align="start"
      >
        {duplicatePickerOpen ? (
          <div>
            <div className="flex items-center gap-2 px-1 py-1.5">
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                className="size-7"
                onClick={onBackFromDuplicate}
                aria-label={translate('auto.components.TaskPage.backToCloseReasons', 'Back')}
              >
                <ChevronLeft className="size-4" />
              </Button>
              <span className="min-w-0 truncate text-[12px] font-semibold">
                {duplicatePickerTitle}
              </span>
            </div>
            <div className="relative px-1 pb-2">
              <Search className="pointer-events-none absolute left-3 top-2.5 size-4 text-muted-foreground" />
              <Input
                autoFocus
                value={duplicateSearch}
                onChange={(event) => onDuplicateSearchChange(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault()
                    onDuplicateSearchSubmit()
                  }
                }}
                placeholder={translate('auto.components.TaskPage.searchIssues', 'Search issues')}
                className="h-9 pl-8 text-[12px]"
                aria-invalid={duplicateError ? true : undefined}
              />
            </div>
            {duplicateError ? (
              <p className="px-2 pb-2 text-[11px] text-destructive">{duplicateError}</p>
            ) : null}
            <div className="scrollbar-sleek max-h-72 overflow-y-auto pr-1">
              {directDuplicateTarget ? (
                <button
                  type="button"
                  onClick={() => onCloseAsDuplicate(directDuplicateTarget)}
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
                  onClick={() => onCloseAsDuplicate(candidate.number)}
                  className="flex w-full items-start gap-2 rounded-sm px-2 py-2 text-left hover:bg-accent"
                >
                  {candidate.state === 'closed' ? (
                    <CircleDashed className="mt-0.5 size-4 shrink-0 text-primary" />
                  ) : (
                    <CircleDot className="mt-0.5 size-4 shrink-0 text-emerald-500" />
                  )}
                  <span className="min-w-0 flex-1">
                    <span className="block text-[12px] font-medium leading-snug">
                      {candidate.title}
                    </span>
                  </span>
                  <span className="shrink-0 text-[12px] text-muted-foreground">
                    #{candidate.number}
                  </span>
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
        ) : (
          <>
            <button
              type="button"
              onClick={() => {
                onStateChange('open')
                onOpenChange(false)
              }}
              className={cn(
                'flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-[12px] hover:bg-accent',
                localState === 'open' && 'bg-accent/50'
              )}
            >
              <CircleDot className="size-4 text-muted-foreground" />
              {translate('auto.components.GitHubItemDialog.dc1ca081a8', 'Open')}
            </button>
            <button
              type="button"
              onClick={() => {
                onStateChange('closed', { stateReason: 'completed' })
                onOpenChange(false)
              }}
              className={cn(
                'flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-[12px] hover:bg-accent',
                localState === 'closed' && 'bg-accent/50'
              )}
            >
              <Check className="size-4 text-muted-foreground" />
              {translate('auto.components.TaskPage.closeAsCompleted', 'Close as completed')}
            </button>
            <button
              type="button"
              onClick={() => {
                onStateChange('closed', { stateReason: 'not_planned' })
                onOpenChange(false)
              }}
              className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-[12px] hover:bg-accent"
            >
              <Ban className="size-4 text-muted-foreground" />
              {translate('auto.components.TaskPage.closeAsNotPlanned', 'Close as not planned')}
            </button>
            <button
              type="button"
              onClick={onOpenDuplicatePicker}
              className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-[12px] hover:bg-accent"
            >
              <Copy className="size-4 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate">
                {translate('auto.components.TaskPage.closeAsDuplicate', 'Close as duplicate')}
              </span>
              <ChevronRight className="size-3.5 text-muted-foreground" />
            </button>
          </>
        )}
      </PopoverContent>
    </Popover>
  )
}
