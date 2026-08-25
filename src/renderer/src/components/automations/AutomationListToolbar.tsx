import React from 'react'
import { Plus, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import { clampAutomationListSearchQueryInput } from './automation-list-search'
import type { AutomationListFilter } from './automation-list-view'
import type { AutomationListArrowKey } from './automation-list-keyboard-navigation'
import { AutomationListFilterMenu, AutomationListFilterPills } from './AutomationListFilterMenu'
import { AutomationListSearchField } from './AutomationListSearchField'
import type { AutomationTemplate } from './automation-templates'

export function AutomationListToolbar({
  listSearchQuery,
  isListSearchQueryTooLarge,
  onListSearchQueryChange,
  onSearchArrowNavigate,
  filter,
  onFilterChange,
  onRefresh,
  isRefreshing,
  openCreateDialog
}: {
  listSearchQuery: string
  isListSearchQueryTooLarge: boolean
  onListSearchQueryChange: (query: string) => void
  onSearchArrowNavigate: (key: AutomationListArrowKey) => void
  filter: AutomationListFilter
  onFilterChange: (filter: AutomationListFilter) => void
  onRefresh: () => void
  isRefreshing: boolean
  openCreateDialog: (template?: AutomationTemplate) => void
}): React.JSX.Element {
  return (
    <div className="flex shrink-0 items-start justify-between gap-3">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <div className="flex shrink-0 items-center gap-2">
          <AutomationListSearchField
            query={listSearchQuery}
            isTooLarge={isListSearchQueryTooLarge}
            className="w-56"
            onQueryChange={(query) =>
              onListSearchQueryChange(clampAutomationListSearchQueryInput(query))
            }
            onClear={() => onListSearchQueryChange('')}
            onArrowNavigate={onSearchArrowNavigate}
          />
          <AutomationListFilterMenu filter={filter} onChange={onFilterChange} />
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
        <AutomationListFilterPills filter={filter} onChange={onFilterChange} />
      </div>
      <Button
        type="button"
        variant="default"
        size="sm"
        className="shrink-0"
        onClick={() => openCreateDialog()}
        data-contextual-tour-target="automations-create"
      >
        <Plus className="size-4" />
        {translate('auto.components.automations.AutomationsPage.newAutomation', 'New Automation')}
      </Button>
    </div>
  )
}
