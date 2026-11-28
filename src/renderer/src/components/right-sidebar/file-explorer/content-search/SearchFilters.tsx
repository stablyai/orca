import React from 'react'
import { ImeInput } from '@/lib/text-input/ime/ime-text-field'
import { Collapsible, CollapsibleContent } from '@/components/ui/collapsible'
import { useTranslate } from '@/i18n/use-translate'
import {
  EXPLORER_QUERY_FIELD_CLASS,
  EXPLORER_QUERY_INPUT_CLASS
} from '../panel/explorer-query-field-class'

export type SearchFiltersProps = {
  open: boolean
  regionId?: string
  includePattern: string
  excludePattern: string
  onIncludeChange: (value: string) => void
  onExcludeChange: (value: string) => void
  includeInputRef?: React.RefObject<HTMLInputElement | null>
  excludeInputRef?: React.RefObject<HTMLInputElement | null>
}

/** Include/exclude inputs in the query field's shell; the query field owns the toggle that opens them. */
export function SearchFilters({
  open,
  regionId,
  includePattern,
  excludePattern,
  onIncludeChange,
  onExcludeChange,
  includeInputRef,
  excludeInputRef
}: SearchFiltersProps): React.JSX.Element {
  const t = useTranslate()
  const activeCount =
    Number(Boolean(includePattern.trim())) + Number(Boolean(excludePattern.trim()))

  return (
    <Collapsible open={open} data-ignore-file-explorer-keys="true">
      <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {t('fileSearch.filters.active', '{{count}} active', { count: activeCount })}
      </span>
      <CollapsibleContent id={regionId} animation="height">
        <div className="space-y-2 pt-2">
          <label className="flex flex-col gap-1">
            <span className="text-2xs text-muted-foreground">
              {t('auto.components.right.sidebar.SearchFilters.a69ee1bd0e', 'files to include')}
            </span>
            <div className={EXPLORER_QUERY_FIELD_CLASS}>
              <ImeInput
                ref={includeInputRef}
                type="text"
                data-file-search-input="true"
                className={EXPLORER_QUERY_INPUT_CLASS}
                placeholder={t(
                  'auto.components.right.sidebar.SearchFilters.8a77efcbd1',
                  'e.g. *.ts, src/**'
                )}
                value={includePattern}
                onChange={(e) => onIncludeChange(e.target.value)}
                spellCheck={false}
              />
            </div>
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-2xs text-muted-foreground">
              {t('auto.components.right.sidebar.SearchFilters.0a6412a895', 'files to exclude')}
            </span>
            <div className={EXPLORER_QUERY_FIELD_CLASS}>
              <ImeInput
                ref={excludeInputRef}
                type="text"
                data-file-search-input="true"
                className={EXPLORER_QUERY_INPUT_CLASS}
                placeholder={t(
                  'auto.components.right.sidebar.SearchFilters.01e4671ccf',
                  'e.g. *.min.js, dist/**'
                )}
                value={excludePattern}
                onChange={(e) => onExcludeChange(e.target.value)}
                spellCheck={false}
              />
            </div>
          </label>
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}
