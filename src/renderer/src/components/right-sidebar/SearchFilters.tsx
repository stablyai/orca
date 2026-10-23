import React from 'react'
import { Ellipsis } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { Input } from '@/components/ui/input'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { translate } from '@/i18n/i18n'

export type SearchFiltersProps = {
  includePattern: string
  excludePattern: string
  onIncludeChange: (value: string) => void
  onExcludeChange: (value: string) => void
  includeInputRef?: React.RefObject<HTMLInputElement | null>
  excludeInputRef?: React.RefObject<HTMLInputElement | null>
}

export function SearchFilters({
  includePattern,
  excludePattern,
  onIncludeChange,
  onExcludeChange,
  includeInputRef,
  excludeInputRef
}: SearchFiltersProps): React.JSX.Element {
  const activeCount =
    Number(Boolean(includePattern.trim())) + Number(Boolean(excludePattern.trim()))

  return (
    <Collapsible
      defaultOpen={activeCount > 0}
      className="relative min-h-6"
      data-ignore-file-explorer-keys="true"
    >
      <div className="absolute right-0 top-0 z-10 flex h-6 items-center gap-1">
        {activeCount > 0 && (
          <span className="text-2xs tabular-nums text-muted-foreground">
            {translate('fileSearch.filters.active', '{{count}} active', { count: activeCount })}
          </span>
        )}
        <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">
          {translate('fileSearch.filters.active', '{{count}} active', { count: activeCount })}
        </span>
        <Tooltip>
          <TooltipTrigger asChild>
            <CollapsibleTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                aria-label={translate('fileSearch.filters.toggle', 'Toggle search details')}
              >
                <Ellipsis />
              </Button>
            </CollapsibleTrigger>
          </TooltipTrigger>
          <TooltipContent side="top" sideOffset={4}>
            {translate('fileSearch.filters.toggle', 'Toggle search details')}
          </TooltipContent>
        </Tooltip>
      </div>
      <CollapsibleContent animation="height">
        <div className="space-y-2 pb-2 pt-1">
          <label className="flex flex-col gap-1">
            <span className="pr-20 text-2xs text-muted-foreground">
              {translate(
                'auto.components.right.sidebar.SearchFilters.a69ee1bd0e',
                'files to include'
              )}
            </span>
            <Input
              ref={includeInputRef}
              type="text"
              data-file-search-input="true"
              density="compact"
              placeholder={translate(
                'auto.components.right.sidebar.SearchFilters.8a77efcbd1',
                'e.g. *.ts, src/**'
              )}
              value={includePattern}
              onChange={(e) => onIncludeChange(e.target.value)}
              spellCheck={false}
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-2xs text-muted-foreground">
              {translate(
                'auto.components.right.sidebar.SearchFilters.0a6412a895',
                'files to exclude'
              )}
            </span>
            <Input
              ref={excludeInputRef}
              type="text"
              data-file-search-input="true"
              density="compact"
              placeholder={translate(
                'auto.components.right.sidebar.SearchFilters.01e4671ccf',
                'e.g. *.min.js, dist/**'
              )}
              value={excludePattern}
              onChange={(e) => onExcludeChange(e.target.value)}
              spellCheck={false}
            />
          </label>
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}
