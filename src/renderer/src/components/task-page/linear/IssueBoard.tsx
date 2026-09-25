import type { TaskPageComposerActionsModel } from '../../use-task-page-composer-actions'
import { translate } from '@/i18n/i18n'
import {
  resolveLinearIssueEmptyKind,
  shouldOfferLinearIssueFetchMore
} from '@/components/task-page-linear-issue-empty-state'
import { Button } from '@/components/ui/button'
import {
  clampLinearIssueListLimit,
  LINEAR_ISSUE_LIST_MAX
} from '../../../../../shared/linear/issue-read-limits'
import { LINEAR_ITEM_LIMIT } from '../../task-page-source-context'
import { TaskPageLinearIssueBoardColumns } from './IssueBoardColumns'
import { TaskPageLinearIssueTable } from './IssueTable'
export function TaskPageLinearIssueBoard({
  model
}: {
  model: TaskPageComposerActionsModel
}): React.JSX.Element | null {
  const {
    linearMode,
    setLinearIssueLimit,
    linearIssuesHasMore,
    linearAttributeFilter,
    linearViewMode,
    activeLinearIssues,
    activeLinearIssueLoading,
    activeLinearIssueError,
    activeLinearIssueHasCollectionError,
    activeLinearIssueContextLabel,
    linearSearchActive,
    filteredLinearIssues
  } = model
  return (
    <div
      className="min-h-0 flex-1 overflow-y-auto scrollbar-sleek"
      style={{
        scrollbarGutter: 'stable'
      }}
    >
      {activeLinearIssueError ? (
        <div className="border-b border-border px-4 py-4 text-sm text-destructive">
          {activeLinearIssueError}
        </div>
      ) : null}

      {activeLinearIssueLoading && activeLinearIssues.length === 0 ? (
        <div className="divide-y divide-border/50">
          {Array.from({
            length: 12
          }).map((_, i) => (
            <div key={i} className="px-3 py-3">
              <div className="h-4 w-4/5 animate-pulse rounded bg-muted/70" />
              <div className="mt-2 h-3 w-3/5 animate-pulse rounded bg-muted/60" />
            </div>
          ))}
        </div>
      ) : null}

      {!activeLinearIssueLoading &&
      activeLinearIssues.length === 0 &&
      !activeLinearIssueError &&
      activeLinearIssueHasCollectionError ? (
        <div className="px-4 py-10 text-center">
          <p className="text-sm font-medium text-foreground">
            {translate('auto.components.TaskPage.cc8795e07c', 'Unable to load Linear issues')}
          </p>
          <p className="mt-2 text-sm text-muted-foreground">
            {translate(
              'auto.components.TaskPage.5ed38a49e5',
              'Review the workspace error below, then refresh.'
            )}
          </p>
        </div>
      ) : null}

      {!activeLinearIssueLoading &&
      activeLinearIssues.length === 0 &&
      !activeLinearIssueError &&
      !activeLinearIssueHasCollectionError ? (
        <div className="px-4 py-10 text-center">
          <p className="text-sm font-medium text-foreground">
            {translate('auto.components.TaskPage.903c7af49f', 'No Linear issues found')}
          </p>
          <p className="mt-2 text-sm text-muted-foreground">
            {(() => {
              if (linearMode === 'in-orca') {
                if (linearSearchActive) {
                  return translate(
                    'auto.components.TaskPage.2bdefbcac3',
                    'Try a different search query.'
                  )
                }
                return translate(
                  'auto.components.TaskPage.linearEmptyHasWorktree',
                  'No Linear tickets are linked to an Orca workspace yet. Start work from a Linear issue to see it here.'
                )
              }
              const emptyKind = resolveLinearIssueEmptyKind({
                hasContextLabel: Boolean(activeLinearIssueContextLabel),
                searchActive: linearSearchActive,
                attributeFilter: linearAttributeFilter,
                serverIssueCount: activeLinearIssues.length,
                filteredIssueCount: filteredLinearIssues.length
              })
              if (emptyKind === 'context') {
                return translate(
                  'auto.components.TaskPage.25ff84769a',
                  'No issues match this Linear context.'
                )
              }
              if (emptyKind === 'search') {
                return translate(
                  'auto.components.TaskPage.2bdefbcac3',
                  'Try a different search query.'
                )
              }
              if (emptyKind === 'server-attribute-filter') {
                return translate(
                  'auto.components.TaskPage.linearEmptyAttributeFilter',
                  'No issues match the selected filters. Clear a filter or try different criteria.'
                )
              }
              return translate(
                'auto.components.TaskPage.linearEmptyUnfilteredScope',
                'No issues in this workspace scope. Try searching or adjusting teams.'
              )
            })()}
          </p>
        </div>
      ) : null}

      {!activeLinearIssueLoading &&
      activeLinearIssues.length > 0 &&
      filteredLinearIssues.length === 0 ? (
        <div className="px-4 py-10 text-center">
          <p className="text-sm font-medium text-foreground">
            {linearMode === 'in-orca' && linearSearchActive
              ? translate('auto.components.TaskPage.903c7af49f', 'No Linear issues found')
              : translate(
                  'auto.components.TaskPage.618107fab3',
                  'No fetched issues match the selected teams'
                )}
          </p>
          <p className="mt-2 text-sm text-muted-foreground">
            {linearMode === 'in-orca' && linearSearchActive
              ? translate('auto.components.TaskPage.2bdefbcac3', 'Try a different search query.')
              : translate(
                  'auto.components.TaskPage.592a55611b',
                  'Try selecting more teams or refreshing; team filters apply to the current fetched issue set.'
                )}
          </p>
          {linearMode !== 'in-orca' &&
          shouldOfferLinearIssueFetchMore({
            emptyKind: 'client-team',
            serverHasMore: linearIssuesHasMore
          }) ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="mt-3 h-7 text-xs"
              onClick={() => {
                setLinearIssueLimit((limit) =>
                  Math.min(
                    clampLinearIssueListLimit(limit + LINEAR_ITEM_LIMIT),
                    LINEAR_ISSUE_LIST_MAX
                  )
                )
              }}
            >
              {translate('auto.components.TaskPage.linearFetchMore', 'Fetch more')}
            </Button>
          ) : null}
        </div>
      ) : null}

      {linearViewMode === 'board' ? (
        <TaskPageLinearIssueBoardColumns model={model} />
      ) : (
        <TaskPageLinearIssueTable model={model} />
      )}
    </div>
  )
}
