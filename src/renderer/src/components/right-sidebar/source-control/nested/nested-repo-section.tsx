import React, { useMemo, useState } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { BulkActionBar } from '../commit/bulk-action-bar'
import { SourceControlPanelContent } from '../panel/panel-content'
import { SourceControlPanelDialogs } from '../panel/panel-dialogs'
import type { SourceControlPanelReadyProps } from '../panel/panel-props'
import { useSourceControlPanelModel } from '../panel/use-panel-model'
import type { NestedFolderScope, NestedRepoStatus } from './use-nested-folder-scope'

/** One stacked repo: its own commit box, file list and Create PR, driven by its own panel model. */
export function NestedRepoSection({
  entry,
  scope,
  parentProps
}: {
  entry: NestedRepoStatus
  scope: NestedFolderScope
  parentProps: SourceControlPanelReadyProps
}): React.JSX.Element {
  const [collapsed, setCollapsed] = useState(false)
  const entries = useMemo(() => entry.status?.entries ?? [], [entry.status])
  const model = useSourceControlPanelModel({
    path: entry.repo.path,
    entries,
    branch: entry.status?.branch ?? '',
    refresh: scope.refreshStatuses,
    filterQuery: parentProps.model.filterQuery
  })
  const props: SourceControlPanelReadyProps = {
    ...parentProps,
    model: {
      ...model,
      fileListScrollElement: parentProps.model.fileListScrollElement,
      isGitHistoryVisible: false
    },
    worktreePath: entry.repo.path
  }
  // Nested repos have no review cache, so the creation check is what finds an existing PR.
  const review = model.hostedReviewCreation?.review ?? null
  const Chevron = collapsed ? ChevronRight : ChevronDown

  return (
    <section
      ref={model.setSourceControlRoot}
      className="flex min-w-0 flex-col border-b border-border pb-1"
      onKeyDown={model.handleSourceControlKeyDown}
    >
      <div className="flex min-w-0 items-center hover:bg-accent">
        <button
          type="button"
          aria-expanded={!collapsed}
          className="flex min-w-0 flex-1 items-center gap-1.5 px-3 py-1 text-left text-[11.5px]"
          onClick={() => setCollapsed((value) => !value)}
        >
          <Chevron className="size-3 shrink-0 text-muted-foreground" aria-hidden="true" />
          <span className="min-w-0 flex-1 truncate font-medium">{entry.repo.displayName}</span>
          {entry.status?.branch ? (
            <span className="max-w-[40%] truncate text-muted-foreground">
              {entry.status.branch}
            </span>
          ) : null}
          <span className="shrink-0 tabular-nums text-muted-foreground">{entries.length}</span>
        </button>
        {review ? (
          <Button
            type="button"
            variant="ghost"
            size="xs"
            title={review.url}
            onClick={() => void window.api.shell.openUrl(review.url)}
          >
            {review.number
              ? `#${review.number}`
              : translate('sourceControl.nestedFolder.openReview', 'Open PR')}
          </Button>
        ) : null}
      </div>
      {entry.error ? <p className="px-3 pb-1 text-[11px] text-destructive">{entry.error}</p> : null}
      {collapsed ? null : <SourceControlPanelContent {...props} />}
      {model.selectedKeys.size > 0 && (
        <BulkActionBar
          selectedCount={model.selectedKeys.size}
          stageableCount={model.bulkStagePaths.length}
          unstageableCount={model.bulkUnstagePaths.length}
          onStage={model.handleBulkStage}
          onUnstage={model.handleBulkUnstage}
          onClear={model.clearSelection}
          isExecuting={model.isExecutingBulk}
        />
      )}
      <SourceControlPanelDialogs {...props} />
    </section>
  )
}
