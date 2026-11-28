import React from 'react'
import { Input } from '@/components/ui/input'
import { Collapsible, CollapsibleContent } from '@/components/ui/collapsible'
import { useTranslate } from '@/i18n/use-translate'

export type SearchFiltersProps = {
  includePattern: string
  excludePattern: string
  onIncludeChange: (value: string) => void
  onExcludeChange: (value: string) => void
  includeInputRef?: React.RefObject<HTMLInputElement | null>
  excludeInputRef?: React.RefObject<HTMLInputElement | null>
}

export function countActiveSearchFilters({
  includePattern,
  excludePattern
}: Pick<SearchFiltersProps, 'includePattern' | 'excludePattern'>): number {
  return Number(Boolean(includePattern.trim())) + Number(Boolean(excludePattern.trim()))
}

/** Include/exclude inputs for text matches; the field owns the toggle that opens them. */
export function SearchFilters({
  open,
  includePattern,
  excludePattern,
  onIncludeChange,
  onExcludeChange,
  includeInputRef,
  excludeInputRef
}: SearchFiltersProps & { open: boolean }): React.JSX.Element {
  const t = useTranslate()
  const activeCount = countActiveSearchFilters({ includePattern, excludePattern })

  return (
    <Collapsible open={open} data-ignore-file-explorer-keys="true">
      <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {t('fileSearch.filters.active', '{{count}} active', { count: activeCount })}
      </span>
      <CollapsibleContent animation="height">
        <div className="space-y-2 pt-2">
          <label className="flex flex-col gap-1">
            <span className="text-2xs text-muted-foreground">
              {t('auto.components.right.sidebar.SearchFilters.a69ee1bd0e', 'files to include')}
            </span>
            <Input
              ref={includeInputRef}
              type="text"
              data-file-search-input="true"
              density="compact"
              placeholder={t(
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
              {t('auto.components.right.sidebar.SearchFilters.0a6412a895', 'files to exclude')}
            </span>
            <Input
              ref={excludeInputRef}
              type="text"
              data-file-search-input="true"
              density="compact"
              placeholder={t(
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
