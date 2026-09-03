import React from 'react'
import { Button } from '@/components/ui/button'
import { CommandGroup, CommandItem, CommandList } from '@/components/ui/command'
import { PopoverContent } from '@/components/ui/popover'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import { getSmartWorkspaceEmptyHint } from './smart-workspace-source-results'
import { getRowItemClassName, RowIcon, RowLabel } from './smart-workspace-source-row-content'
import type { SmartWorkspaceNameFieldController } from './use-smart-workspace-name-field-controller'

export function renderSmartWorkspaceSourceResults(
  controller: SmartWorkspaceNameFieldController
): React.JSX.Element {
  const {
    localInputRef,
    tabsListRef,
    mode,
    mrStateFilters,
    mrStateFilter,
    setMrStateFilter,
    typedTextActionRow,
    handleSelect,
    jiraSource,
    loading,
    searchResultRows,
    linearStatusChecked,
    linearStatus,
    showJiraSiteContext,
    jiraConnectionStatus,
    reserveLinearLoadingResults,
    showLinearUrlLoadingFeedback
  } = controller

  return (
    <PopoverContent
      data-workspace-source-suggestions="true"
      align="start"
      side="bottom"
      sideOffset={4}
      avoidCollisions={false}
      className="popover-scroll-content flex w-[var(--radix-popover-trigger-width)] flex-col p-0"
      // Why: results must not cover the create-workspace dialog's submit footer.
      style={{ maxHeight: 'min(var(--radix-popover-content-available-height,7rem),7rem)' }}
      onOpenAutoFocus={(event) => event.preventDefault()}
      onPointerDownOutside={(event) => {
        // Why: Radix sees input and mode tabs as outside because the input is an anchor.
        const target = event.target as Node
        if (localInputRef.current?.contains(target) || tabsListRef.current?.contains(target)) {
          event.preventDefault()
        }
      }}
      onFocusOutside={(event) => {
        const target = event.target as Node
        if (localInputRef.current?.contains(target) || tabsListRef.current?.contains(target)) {
          event.preventDefault()
        }
      }}
    >
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
        {typedTextActionRow ? (
          <div
            className="sticky top-0 z-10 border-b border-border/40 bg-popover p-1"
            onMouseDown={(event) => event.preventDefault()}
          >
            <CommandItem
              key={typedTextActionRow.value}
              value={typedTextActionRow.value}
              onSelect={() => handleSelect(typedTextActionRow)}
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
                : getSmartWorkspaceEmptyHint(mode)}
          </div>
        ) : searchResultRows.length > 0 ? (
          <CommandGroup className="p-1">
            {searchResultRows.map((row) => (
              <CommandItem
                key={row.value}
                value={row.value}
                onSelect={() => handleSelect(row)}
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
              </CommandItem>
            ))}
          </CommandGroup>
        ) : null}
      </CommandList>
    </PopoverContent>
  )
}
