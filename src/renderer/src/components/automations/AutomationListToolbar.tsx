import React from 'react'
import { History, Plus, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import type { AutomationHostCatalogEntry } from './automation-host-catalog-types'
import type { AutomationListArrowKey } from './automation-list-keyboard-navigation'
import { clampAutomationListSearchQueryInput } from './automation-list-search'
import type { AutomationListFilter } from './automation-list-view'
import { AutomationListSearchField } from './AutomationListSearchField'
import { AutomationListFilterMenu } from './AutomationListFilterMenu'
import type { AutomationTemplate } from './automation-templates'

type AutomationListToolbarProps = {
  /** Focus fallback for the list: the controls that produced the rows. */
  toolbarRef: React.RefObject<HTMLDivElement | null>
  listSearchQuery: string
  isListSearchQueryTooLarge: boolean
  onListSearchQueryChange: (query: string) => void
  onSearchArrowNavigate: (key: AutomationListArrowKey) => void
  onSearchEnter: () => void
  listFilter: AutomationListFilter
  onListFilterChange: (filter: AutomationListFilter) => void
  hostEntries: readonly AutomationHostCatalogEntry[]
  onRefresh: () => void
  isRefreshing: boolean
  onOpenRuns: () => void
  openCreateDialog: (template?: AutomationTemplate) => void
  canCreateAutomation: boolean
}

export function AutomationListToolbar({
  toolbarRef,
  listSearchQuery,
  isListSearchQueryTooLarge,
  onListSearchQueryChange,
  onSearchArrowNavigate,
  onSearchEnter,
  listFilter,
  onListFilterChange,
  hostEntries,
  onRefresh,
  isRefreshing,
  onOpenRuns,
  openCreateDialog,
  canCreateAutomation
}: AutomationListToolbarProps): React.JSX.Element {
  return (
    <div className="flex shrink-0 items-end justify-between gap-3 pb-4">
      <div ref={toolbarRef} className="flex min-w-0 flex-1 items-end gap-2">
        <AutomationListSearchField
          className="w-full max-w-xs"
          query={listSearchQuery}
          isTooLarge={isListSearchQueryTooLarge}
          onQueryChange={(query) =>
            onListSearchQueryChange(clampAutomationListSearchQueryInput(query))
          }
          onClear={() => onListSearchQueryChange('')}
          onArrowNavigate={onSearchArrowNavigate}
          onEnter={onSearchEnter}
        />
        <AutomationListFilterMenu
          filter={listFilter}
          onChange={onListFilterChange}
          hostEntries={hostEntries}
        />
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={translate(
                'auto.components.automations.AutomationsPage.19a6e30eae',
                'Refresh automations'
              )}
              onClick={onRefresh}
              disabled={isRefreshing}
              className="shrink-0 border border-border bg-background shadow-none hover:bg-muted/50"
            >
              <RefreshCw className={cn('size-4', isRefreshing && 'animate-spin')} />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom" sideOffset={6}>
            {translate(
              'auto.components.automations.AutomationsPage.19a6e30eae',
              'Refresh automations'
            )}
          </TooltipContent>
        </Tooltip>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={onOpenRuns}
          data-contextual-tour-target="automations-runs"
        >
          <History className="size-4" />
          {translate('auto.components.automations.AutomationListToolbar.runs', 'Runs')}
        </Button>
        <Button
          type="button"
          size="sm"
          className="shrink-0"
          onClick={() => openCreateDialog()}
          disabled={!canCreateAutomation}
          data-contextual-tour-target="automations-create"
        >
          <Plus className="size-4" />
          {translate('auto.components.automations.AutomationsPage.newAutomation', 'New Automation')}
        </Button>
      </div>
    </div>
  )
}
