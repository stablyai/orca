import type { TaskPageComposerActionsModel } from '../use-task-page-composer-actions'
import { useIntlLocale, useTranslate } from '@/i18n/use-translate'
import { useAppStore } from '@/store'
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { ArrowRight } from 'lucide-react'
import { cn } from '@/lib/class-names'
import { getWorkItemRepo } from '@/lib/work-items/work-item-repo-row'
import { GitLabItemActions } from './GitLabItemActions'

const GITLAB_ITEM_GRID_CLASS =
  'grid grid-cols-[80px_minmax(0,3fr)_120px_110px_56px] @max-xl:grid-cols-[48px_minmax(0,1fr)_76px_56px] gap-3 px-3 py-2'

export function TaskPageGitLabItemList({
  model
}: {
  model: TaskPageComposerActionsModel
}): React.JSX.Element | null {
  const t = useTranslate()
  const intlLocale = useIntlLocale()
  const {
    gitlabItems,
    gitlabLoading,
    gitlabError,
    gitlabEmptyState,
    displayedGitLabItems,
    openGitLabDetailPage,
    handleUseGitLabItem,
    selectedRepos,
    setGitlabRefreshNonce
  } = model
  return (
    <div className="@container flex min-h-0 max-h-full flex-col rounded-md border border-t-0 border-border/50 bg-muted/50 overflow-hidden rounded-t-none shadow-sm">
      <div
        className={cn(
          GITLAB_ITEM_GRID_CLASS,
          'flex-none border-b border-border/50 text-[10px] font-medium uppercase tracking-[0.16em] text-muted-foreground'
        )}
      >
        <span>{t('auto.components.TaskPage.eb10c32872', 'ID')}</span>
        <span>{t('auto.components.TaskPage.16cba35bee', 'Title')}</span>
        <span>{t('auto.components.TaskPage.00b7ffb952', 'Type / State')}</span>
        <span className="@max-xl:hidden">
          {t('auto.components.TaskPage.f362667d55', 'Updated')}
        </span>
        <span />
      </div>
      <div
        className="min-h-0 flex-initial overflow-y-auto scrollbar-sleek"
        style={{
          scrollbarGutter: 'stable'
        }}
      >
        {gitlabError ? (
          <div className="border-b border-border px-4 py-4 text-sm text-destructive">
            {gitlabError}
          </div>
        ) : null}
        {gitlabLoading && gitlabItems.length === 0 ? (
          // Fill the viewport with shimmer rows to prevent a loading height jump.
          <div className="divide-y divide-border/50">
            {Array.from({
              length: 12
            }).map((_, i) => (
              <div key={i} className={cn(GITLAB_ITEM_GRID_CLASS, 'w-full')}>
                <div className="h-4 w-16 max-w-full animate-pulse rounded bg-muted/70" />
                <div>
                  <div className="h-4 w-3/5 animate-pulse rounded bg-muted/70" />
                </div>
                <div className="h-3 w-20 max-w-full animate-pulse rounded bg-muted/60" />
                <div className="h-3 w-20 animate-pulse rounded bg-muted/60 @max-xl:hidden" />
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
              key={`${item.repoId}:${item.repoHostId ?? ''}:${item.id}:${item.url}`}
              onClick={() => {
                useAppStore.getState().recordFeatureInteraction('gitlab-tasks')
                openGitLabDetailPage(item)
              }}
              onKeyDown={(e) => {
                if (e.target !== e.currentTarget) {
                  return
                }
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  useAppStore.getState().recordFeatureInteraction('gitlab-tasks')
                  openGitLabDetailPage(item)
                }
              }}
              className={cn(
                GITLAB_ITEM_GRID_CLASS,
                'w-full cursor-pointer text-left hover:bg-muted/50'
              )}
            >
              <span className="font-mono text-xs text-muted-foreground">
                {/* Why: GitLab uses !N for MRs and #N for issues — match gitlab.com so rows map to web links. */}
                {item.type === 'mr' ? '!' : '#'}
                {item.number}
              </span>
              <div className="min-w-0">
                <span className="block truncate text-sm" title={item.title}>
                  {item.title}
                </span>
                {item.labels.length > 0 ? (
                  <div className="mt-1 flex flex-wrap gap-1">
                    {item.labels.map((label) => (
                      <Badge
                        key={label}
                        variant="referenceLabel"
                        className="max-w-full"
                        title={label}
                      >
                        <span className="truncate">{label}</span>
                      </Badge>
                    ))}
                  </div>
                ) : null}
              </div>
              <span className="text-xs text-muted-foreground">
                {item.type === 'mr'
                  ? t('auto.components.TaskPage.e224d76876', 'MR')
                  : t('auto.components.TaskPage.b1eaa18ace', 'Issue')}{' '}
                · {item.state}
              </span>
              <span className="text-xs text-muted-foreground @max-xl:hidden">
                {item.updatedAt ? new Date(item.updatedAt).toLocaleDateString(intlLocale) : ''}
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
                      aria-label={
                        item.type === 'mr'
                          ? t(
                              'auto.components.TaskPage.startWorkspaceFromMr',
                              'Start workspace from MR {{number}}',
                              { number: item.number }
                            )
                          : t(
                              'auto.components.TaskPage.startWorkspaceFromIssue',
                              'Start workspace from issue {{number}}',
                              { number: item.number }
                            )
                      }
                    >
                      <ArrowRight className="size-3.5" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom" sideOffset={6}>
                    {t('auto.components.TaskPage.9497f2787c', 'Start workspace')}
                  </TooltipContent>
                </Tooltip>
                <GitLabItemActions
                  item={item}
                  repo={getWorkItemRepo(selectedRepos, item)}
                  onRefresh={() => setGitlabRefreshNonce((nonce) => nonce + 1)}
                />
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
