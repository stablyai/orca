import React from 'react'
import { ArrowRight, ExternalLink } from 'lucide-react'

import { useAppStore } from '@/store'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import type { RepoBackedTaskEmptyState } from '@/components/task-page-empty-state'
import { getIntlLocale, translate } from '@/i18n/i18n'
import type { GitLabWorkItem } from '../../../../../shared/gitlab-types'

export type GitlabWorkItemListProps = {
  gitlabError: string | null
  gitlabLoading: boolean
  gitlabItems: readonly GitLabWorkItem[]
  displayedGitLabItems: readonly GitLabWorkItem[]
  gitlabEmptyState: RepoBackedTaskEmptyState
  openGitLabDetailPage: (item: GitLabWorkItem) => void
  handleUseGitLabItem: (item: GitLabWorkItem) => void
}

export function GitlabWorkItemList({
  gitlabError,
  gitlabLoading,
  gitlabItems,
  displayedGitLabItems,
  gitlabEmptyState,
  openGitLabDetailPage,
  handleUseGitLabItem
}: GitlabWorkItemListProps): React.JSX.Element {
  return (
    <div className="flex min-h-0 max-h-full flex-col rounded-md border border-t-0 border-border/50 bg-muted/50 overflow-hidden rounded-t-none shadow-sm">
      <div className="flex-none grid grid-cols-[80px_minmax(0,3fr)_120px_110px_50px] gap-3 border-b border-border/50 px-3 py-2 text-[10px] font-medium uppercase tracking-[0.16em] text-muted-foreground">
        <span>{translate('auto.components.TaskPage.eb10c32872', 'ID')}</span>
        <span>{translate('auto.components.TaskPage.16cba35bee', 'Title')}</span>
        <span>{translate('auto.components.TaskPage.00b7ffb952', 'Type / State')}</span>
        <span>{translate('auto.components.TaskPage.f362667d55', 'Updated')}</span>
        <span />
      </div>
      <div
        className="min-h-0 flex-initial overflow-y-auto scrollbar-sleek"
        style={{ scrollbarGutter: 'stable' }}
      >
        {gitlabError ? (
          <div className="border-b border-border px-4 py-4 text-sm text-destructive">
            {gitlabError}
          </div>
        ) : null}
        {gitlabLoading && gitlabItems.length === 0 ? (
          // Why: shimmer rows fill the viewport so the card never flashes empty and the table doesn't jump when real rows land.
          <div className="divide-y divide-border/50">
            {Array.from({ length: 12 }).map((_, i) => (
              <div
                key={i}
                className="grid w-full gap-3 px-3 py-2 grid-cols-[80px_minmax(0,3fr)_120px_110px_50px]"
              >
                <div className="h-4 w-16 animate-pulse rounded bg-muted/70" />
                <div>
                  <div className="h-4 w-3/5 animate-pulse rounded bg-muted/70" />
                </div>
                <div className="h-3 w-20 animate-pulse rounded bg-muted/60" />
                <div className="h-3 w-20 animate-pulse rounded bg-muted/60" />
                <div />
              </div>
            ))}
          </div>
        ) : null}
        {!gitlabLoading && displayedGitLabItems.length === 0 && !gitlabError ? (
          <div className="px-4 py-12 text-center">
            <p className="text-base font-medium text-foreground">{gitlabEmptyState.title}</p>
            <p className="mt-2 text-sm text-muted-foreground">{gitlabEmptyState.description}</p>
          </div>
        ) : null}
        <div className="divide-y divide-border/50">
          {displayedGitLabItems.map((item) => (
            // Why: div role="button" not a <button> — it nests an open-in-browser button, and button-in-button is invalid HTML.
            <div
              role="button"
              tabIndex={0}
              key={`${item.repoId}:${item.id}`}
              onClick={() => {
                useAppStore.getState().recordFeatureInteraction('gitlab-tasks')
                openGitLabDetailPage(item)
              }}
              onKeyDown={(event) => {
                if (event.target !== event.currentTarget) {
                  return
                }
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault()
                  useAppStore.getState().recordFeatureInteraction('gitlab-tasks')
                  openGitLabDetailPage(item)
                }
              }}
              className="grid w-full cursor-pointer gap-3 px-3 py-2 text-left grid-cols-[80px_minmax(0,3fr)_120px_110px_50px] hover:bg-muted/50"
            >
              <span className="font-mono text-xs text-muted-foreground">
                {/* Why: GitLab uses !N for MRs and #N for issues — match gitlab.com so rows map to web links. */}
                {item.type === 'mr' ? '!' : '#'}
                {item.number}
              </span>
              <span className="min-w-0 truncate text-sm">{item.title}</span>
              <span className="text-xs text-muted-foreground">
                {item.type === 'mr'
                  ? translate('auto.components.TaskPage.e224d76876', 'MR')
                  : translate('auto.components.TaskPage.b1eaa18ace', 'Issue')}{' '}
                · {item.state}
              </span>
              <span className="text-xs text-muted-foreground">
                {item.updatedAt ? new Date(item.updatedAt).toLocaleDateString(getIntlLocale()) : ''}
              </span>
              <div className="flex items-center justify-end gap-1">
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      data-contextual-tour-target="tasks-start-workspace"
                      onClick={(event) => {
                        event.stopPropagation()
                        handleUseGitLabItem(item)
                      }}
                      aria-label={translate(
                        'auto.components.TaskPage.5e8061b088',
                        'Start workspace from {{value0}} {{value1}}',
                        { value0: item.type === 'mr' ? 'MR' : 'issue', value1: item.number }
                      )}
                    >
                      <ArrowRight className="size-3.5" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom" sideOffset={6}>
                    {translate('auto.components.TaskPage.9497f2787c', 'Start workspace')}
                  </TooltipContent>
                </Tooltip>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation()
                    void window.api.shell.openUrl(item.url)
                  }}
                  aria-label={translate('auto.components.TaskPage.bcdc1330b2', 'Open in GitLab')}
                  className="text-muted-foreground hover:text-foreground"
                >
                  <ExternalLink className="size-3.5" />
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
