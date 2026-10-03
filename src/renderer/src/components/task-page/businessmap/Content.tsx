import type { TaskPageComposerActionsModel } from '../../use-task-page-composer-actions'
import { LoaderCircle } from 'lucide-react'
import { BusinessmapIcon } from '@/components/icons/BusinessmapIcon'
import { translate } from '@/i18n/i18n'
import { Button } from '@/components/ui/button'
import { TaskPageBusinessmapSortControls } from '../../task-page-businessmap-sort-controls'
import { TaskPageJiraErrorBanner } from '../../task-page-linear-jira-list-model'
import { TaskPageBusinessmapCardList } from '@/components/task-page-businessmap-card-list'
import { formatRelativeTime } from '../../task-page-source-context'
import { getBusinessmapCardStatusTone } from '@/components/task-page-businessmap-status-tone'
import BusinessmapCardWorkspace from '@/components/BusinessmapCardWorkspace'
import { TaskPageLinearContent } from '../linear/Content'
export function TaskPageBusinessmapContent({
  model
}: {
  model: TaskPageComposerActionsModel
}): React.JSX.Element | null {
  const {
    businessmapStatusReady,
    businessmapConnected,
    hideTaskSource,
    taskSource,
    closeTaskDetailPage,
    selectedBusinessmapCard,
    businessmapDetailSourceContext,
    openBusinessmapCardDetailPage,
    businessmapCards,
    businessmapLoading,
    businessmapError,
    businessmapErrorDetailsOpen,
    setBusinessmapErrorDetailsOpen,
    businessmapSearchInput,
    businessmapOrderBy,
    businessmapOrderDirection,
    handleBusinessmapSort,
    displayedBusinessmapCards,
    sortedBusinessmapCards,
    setBusinessmapConnectOpen,
    handleUseBusinessmapItem
  } = model
  return taskSource === 'businessmap' ? (
    !businessmapStatusReady ? (
      <div className="mt-4 flex items-center justify-center py-14">
        <LoaderCircle className="size-5 animate-spin text-muted-foreground" />
      </div>
    ) : !businessmapConnected ? (
      <div className="mt-4 flex flex-col items-center justify-center rounded-md border border-border/50 bg-muted/50 px-6 py-14 text-center shadow-sm">
        <BusinessmapIcon className="mb-4 size-8 text-muted-foreground/60" />
        <p className="text-base font-medium text-foreground">
          {translate(
            'auto.components.TaskPage.businessmapConnectTitle',
            'Connect your Businessmap site'
          )}
        </p>
        <p className="mt-2 max-w-sm text-sm text-muted-foreground">
          {translate(
            'auto.components.TaskPage.businessmapConnectBody',
            'Browse, edit, create, and start work from Businessmap cards directly from here.'
          )}
        </p>
        <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
          <Button onClick={() => setBusinessmapConnectOpen(true)}>
            {translate('auto.components.TaskPage.businessmapConnect', 'Connect Businessmap')}
          </Button>
          <Button variant="outline" onClick={() => hideTaskSource('businessmap', 'Businessmap')}>
            {translate('auto.components.TaskPage.businessmapHide', 'Hide Businessmap')}
          </Button>
        </div>
      </div>
    ) : (
      <div className="flex min-h-0 max-h-full flex-col overflow-hidden rounded-md rounded-t-none border border-t-0 border-border/50 bg-background shadow-sm">
        <div className="flex h-10 flex-none items-center justify-between gap-3 border-b border-border/50 bg-muted/35 px-3">
          <div className="min-w-0 text-[11px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
            {translate('auto.components.TaskPage.businessmapCards', 'Businessmap cards')}
          </div>
          <div className="shrink-0 text-[11px] text-muted-foreground">
            {displayedBusinessmapCards.length}{' '}
            {translate('auto.components.TaskPage.b7bae28b6a', 'shown')}
          </div>
        </div>

        <TaskPageBusinessmapSortControls
          direction={businessmapOrderDirection}
          onSort={handleBusinessmapSort}
          orderBy={businessmapOrderBy}
        />

        <div
          className="min-h-0 flex-1 overflow-y-auto scrollbar-sleek"
          style={{
            scrollbarGutter: 'stable'
          }}
        >
          {businessmapError ? (
            <TaskPageJiraErrorBanner
              error={businessmapError}
              open={businessmapErrorDetailsOpen}
              onOpenChange={setBusinessmapErrorDetailsOpen}
            />
          ) : null}

          {businessmapLoading && businessmapCards.length === 0 ? (
            <div className="divide-y divide-border/50">
              {Array.from({
                length: 6
              }).map((_, i) => (
                <div key={i} className="px-3 py-3">
                  <div className="h-4 w-4/5 animate-pulse rounded bg-muted/70" />
                  <div className="mt-2 h-3 w-3/5 animate-pulse rounded bg-muted/60" />
                </div>
              ))}
            </div>
          ) : null}

          {!businessmapLoading && businessmapCards.length === 0 && !businessmapError ? (
            <div className="px-4 py-10 text-center">
              <p className="text-sm font-medium text-foreground">
                {translate(
                  'auto.components.TaskPage.businessmapEmpty',
                  'No Businessmap cards found'
                )}
              </p>
              <p className="mt-2 text-sm text-muted-foreground">
                {businessmapSearchInput
                  ? translate(
                      'auto.components.TaskPage.businessmapEmptySearch',
                      'Try a different search.'
                    )
                  : translate(
                      'auto.components.TaskPage.94d900518d',
                      'No issues match the selected preset.'
                    )}
              </p>
            </div>
          ) : null}

          <TaskPageBusinessmapCardList
            formatUpdatedAt={formatRelativeTime}
            getStatusTone={getBusinessmapCardStatusTone}
            cards={sortedBusinessmapCards}
            onOpenCard={openBusinessmapCardDetailPage}
            onStartWorkspace={handleUseBusinessmapItem}
            selectedCard={selectedBusinessmapCard}
          />
        </div>
        <BusinessmapCardWorkspace
          card={selectedBusinessmapCard}
          onUse={handleUseBusinessmapItem}
          onClose={closeTaskDetailPage}
          sourceContext={businessmapDetailSourceContext}
        />
      </div>
    )
  ) : (
    <TaskPageLinearContent model={model} />
  )
}
