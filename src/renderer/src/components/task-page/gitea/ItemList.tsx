import { RailPageScroll } from '@/components/rail-page/RailPage'
import { ArrowRight, ExternalLink } from 'lucide-react'
import type { TaskPageComposerActionsModel } from '../use-task-page-composer-actions'
import { useIntlLocale, useTranslate } from '@/i18n/use-translate'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { Button } from '@/components/ui/button'
import { openAppHttpLink } from '@/lib/browser/navigation/app-http-link-open'
import { giteaItemStateLabel } from './gitea-task-options'
import type { GiteaTaskRow } from './use-task-page-gitea-list'

const COLUMNS = 'grid-cols-[80px_minmax(0,3fr)_120px_110px_50px]'

export function TaskPageGiteaItemList({
  model,
  onOpen,
  onUse
}: {
  model: TaskPageComposerActionsModel
  onOpen: (item: GiteaTaskRow) => void
  onUse: (item: GiteaTaskRow) => void
}): React.JSX.Element {
  const t = useTranslate()
  const intlLocale = useIntlLocale()
  const { giteaItems, giteaLoading, giteaError, displayedGiteaItems, selectedRepos } = model
  return (
    <div className="flex min-h-0 max-h-full flex-col overflow-hidden bg-background">
      <div
        className={`flex-none grid ${COLUMNS} gap-3 border-b border-border/50 rail-page-row-gutter py-2 text-[10px] font-medium uppercase tracking-[0.16em] text-muted-foreground`}
      >
        <span>{t('auto.components.TaskPage.eb10c32872', 'ID')}</span>
        <span>{t('auto.components.TaskPage.16cba35bee', 'Title')}</span>
        <span>{t('auto.components.TaskPage.00b7ffb952', 'Type / State')}</span>
        <span>{t('auto.components.TaskPage.f362667d55', 'Updated')}</span>
        <span />
      </div>
      <RailPageScroll className="min-h-0 flex-initial overflow-y-auto scrollbar-sleek">
        {giteaError ? (
          <div className="border-b border-border px-4 py-4 text-sm text-destructive">
            {giteaError}
          </div>
        ) : null}
        {giteaLoading && giteaItems.length === 0 ? (
          // Fill the viewport with shimmer rows to prevent a loading height jump.
          <div className="divide-y divide-border/50">
            {Array.from({ length: 12 }).map((_, i) => (
              <div key={i} className={`grid w-full gap-3 rail-page-row-gutter py-2 ${COLUMNS}`}>
                <div className="h-4 w-16 animate-pulse rounded bg-muted/70" />
                <div className="h-4 w-3/5 animate-pulse rounded bg-muted/70" />
                <div className="h-3 w-20 animate-pulse rounded bg-muted/60" />
                <div className="h-3 w-20 animate-pulse rounded bg-muted/60" />
                <div />
              </div>
            ))}
          </div>
        ) : null}
        {!giteaLoading && displayedGiteaItems.length === 0 && !giteaError ? (
          <div className="px-4 py-12 text-center">
            <p className="text-base font-medium text-foreground">
              {selectedRepos.length === 0
                ? t('auto.components.TaskPage.giteaEmptyNoProjects', 'No projects selected')
                : t('auto.components.TaskPage.giteaEmptyTitle', 'No Gitea items')}
            </p>
            <p className="mt-2 text-sm text-muted-foreground">
              {selectedRepos.length === 0
                ? t(
                    'auto.components.TaskPage.giteaEmptyNoProjectsDescription',
                    'Select a Gitea-hosted project to see its issues and pull requests.'
                  )
                : t(
                    'auto.components.TaskPage.giteaEmptyDescription',
                    'Nothing matches this filter in the selected projects.'
                  )}
            </p>
          </div>
        ) : null}
        <div className="divide-y divide-border/50">
          {displayedGiteaItems.map((item) => (
            // div role="button": it nests an open-in-browser button, and button-in-button is invalid HTML.
            <div
              role="button"
              tabIndex={0}
              key={`${item.repoId}:${item.repoHostId}:${item.id}`}
              onClick={() => onOpen(item)}
              onKeyDown={(e) => {
                if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) {
                  e.preventDefault()
                  onOpen(item)
                }
              }}
              className={`grid w-full cursor-pointer gap-3 rail-page-row-gutter py-2 text-left ${COLUMNS} hover:bg-muted/50`}
            >
              <span className="font-mono text-xs text-muted-foreground">#{item.number}</span>
              <span className="flex min-w-0 items-center gap-2">
                <span className="min-w-0 truncate text-sm">{item.title}</span>
                {item.labels.slice(0, 3).map((label) => (
                  <span
                    key={label}
                    className="shrink-0 rounded border border-border/50 px-1.5 text-[10px] text-muted-foreground"
                  >
                    {label}
                  </span>
                ))}
              </span>
              <span className="text-xs text-muted-foreground">
                {item.type === 'pull'
                  ? t('auto.components.TaskPage.giteaTypePr', 'PR')
                  : t('auto.components.TaskPage.b1eaa18ace', 'Issue')}{' '}
                · {giteaItemStateLabel(item)}
              </span>
              <span className="text-xs text-muted-foreground">
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
                        onUse(item)
                      }}
                      aria-label={
                        item.type === 'pull'
                          ? t(
                              'auto.components.TaskPage.startWorkspaceFromPr',
                              'Start workspace from PR {{number}}',
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
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation()
                    openAppHttpLink(item.url, { event: e })
                  }}
                  aria-label={t('auto.components.TaskPage.openInGitea', 'Open in Gitea')}
                  className="text-muted-foreground hover:text-foreground"
                >
                  <ExternalLink className="size-3.5" />
                </button>
              </div>
            </div>
          ))}
        </div>
      </RailPageScroll>
    </div>
  )
}
