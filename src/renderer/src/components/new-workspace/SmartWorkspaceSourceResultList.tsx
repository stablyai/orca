import React from 'react'
import { Button } from '@/components/ui/button'
import { CommandGroup, CommandItem, CommandList } from '@/components/ui/command'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import { getSmartWorkspaceEmptyHint } from '../../../../shared/new-workspace/smart-workspace-source-results'
import { getRowItemClassName, RowIcon, RowLabel } from './smart-workspace-source-row-content'
import type { RowEntry } from './smart-workspace-name-field-model'
import type { WorkItemSourceSearch } from './use-work-item-source-search'

export function SmartWorkspaceSourceResultList({
  model,
  onSelect,
  isLinked,
  beforeResults,
  emptyHint,
  isRowDisabled
}: {
  model: Pick<
    WorkItemSourceSearch,
    | 'mode'
    | 'mrStateFilters'
    | 'mrStateFilter'
    | 'setMrStateFilter'
    | 'typedTextActionRow'
    | 'jiraSource'
    | 'loading'
    | 'searchResultRows'
    | 'linearStatusChecked'
    | 'linearStatus'
    | 'showJiraSiteContext'
    | 'jiraConnectionStatus'
    | 'reserveLinearLoadingResults'
    | 'showLinearUrlLoadingFeedback'
  >
  onSelect: (row: RowEntry) => void
  isLinked?: (row: RowEntry) => boolean
  beforeResults?: React.ReactNode
  emptyHint?: string
  isRowDisabled?: (row: RowEntry) => boolean
}): React.JSX.Element {
  const {
    mode,
    mrStateFilters,
    mrStateFilter,
    setMrStateFilter,
    typedTextActionRow,
    jiraSource,
    loading,
    searchResultRows,
    linearStatusChecked,
    linearStatus,
    showJiraSiteContext,
    jiraConnectionStatus,
    reserveLinearLoadingResults,
    showLinearUrlLoadingFeedback
  } = model
  return (
    <>
      {mode === 'gitlab' ? (
        // Why: state chips mirror GitLab's merge-request tab strip.
        <div
          className="flex shrink-0 items-center gap-1 border-b border-border/40 px-2 py-1.5"
          onMouseDown={(e) => e.preventDefault()}
        >
          {mrStateFilters.map(({ id, label }) => (
            <Button
              key={id}
              type="button"
              variant={mrStateFilter === id ? 'secondary' : 'ghost'}
              size="sm"
              onClick={() => setMrStateFilter(id)}
              className="h-6 px-2 text-xs"
            >
              {label}
            </Button>
          ))}
        </div>
      ) : null}
      <CommandList className="!max-h-none min-h-0 flex-1 scrollbar-sleek">
        {beforeResults}
        {typedTextActionRow ? (
          <div
            className="sticky top-0 z-10 border-b border-border/40 bg-popover p-1"
            onMouseDown={(event) => event.preventDefault()}
          >
            <CommandItem
              selection="palette"
              key={typedTextActionRow.value}
              value={typedTextActionRow.value}
              onSelect={() => onSelect(typedTextActionRow)}
              className={getRowItemClassName(typedTextActionRow, { pinnedAction: true })}
            >
              <RowIcon row={typedTextActionRow} />
              <RowLabel row={typedTextActionRow} />
            </CommandItem>
          </div>
        ) : null}
        {jiraSource.errorKind ? null : reserveLinearLoadingResults ? (
          <div
            aria-hidden="true"
            className={cn('space-y-1 p-1', !showLinearUrlLoadingFeedback && 'invisible')}
          >
            {[0, 1, 2].map((index) => (
              <div
                key={index}
                className={cn(
                  'h-8 rounded bg-muted/40',
                  showLinearUrlLoadingFeedback && 'animate-pulse'
                )}
              />
            ))}
          </div>
        ) : loading && searchResultRows.length === 0 ? (
          <div className="space-y-1 p-1">
            {[0, 1, 2].map((index) => (
              <div key={index} className="h-8 animate-pulse rounded bg-muted/40" />
            ))}
          </div>
        ) : searchResultRows.length === 0 && !typedTextActionRow ? (
          <div className="px-3 py-6 text-center text-xs text-muted-foreground">
            {jiraSource.intent
              ? null
              : mode === 'linear' && linearStatusChecked && !linearStatus.connected
                ? translate(
                    'auto.components.new.workspace.SmartWorkspaceNameField.3e8bb1176a',
                    'Connect Linear in Settings to search issues.'
                  )
                : (emptyHint ?? getSmartWorkspaceEmptyHint(mode))}
          </div>
        ) : searchResultRows.length > 0 ? (
          <CommandGroup className="p-1">
            {searchResultRows.map((row) => (
              <CommandItem
                selection="palette"
                key={row.value}
                value={row.value}
                disabled={isLinked?.(row) || isRowDisabled?.(row)}
                onSelect={() => onSelect(row)}
                className={getRowItemClassName(row)}
              >
                <RowIcon row={row} />
                <RowLabel
                  row={row}
                  jiraSite={
                    showJiraSiteContext && row.kind === 'jira'
                      ? (jiraConnectionStatus?.sites?.find(
                          (site) => site.id === row.issue.siteId
                        ) ?? null)
                      : null
                  }
                  showJiraSiteContext={showJiraSiteContext}
                />
                {isLinked?.(row) ? (
                  <span className="ml-auto shrink-0 text-xs text-muted-foreground">
                    {translate('workspace.links.linkedResult', 'Linked')}
                  </span>
                ) : null}
              </CommandItem>
            ))}
          </CommandGroup>
        ) : null}
      </CommandList>
    </>
  )
}
