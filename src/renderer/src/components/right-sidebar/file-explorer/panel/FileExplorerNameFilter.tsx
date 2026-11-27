import React from 'react'
import { ListFilter, Loader2, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useTranslate } from '@/i18n/use-translate'
import {
  EXPLORER_QUERY_FIELD_CLASS,
  EXPLORER_QUERY_INPUT_CLASS
} from './explorer-query-field-class'

type FileExplorerNameFilterProps = {
  query: string
  scopeLabel?: string
  loading?: boolean
  onQueryChange: (value: string) => void
  onClear: () => void
}

export function FileExplorerNameFilter({
  query,
  scopeLabel,
  loading = false,
  onQueryChange,
  onClear
}: FileExplorerNameFilterProps): React.JSX.Element {
  const t = useTranslate()
  return (
    <div className={EXPLORER_QUERY_FIELD_CLASS} data-ignore-file-explorer-keys="true">
      <ListFilter className="size-3.5 shrink-0 text-muted-foreground" />
      <input
        type="text"
        data-explorer-query-input="files"
        className={EXPLORER_QUERY_INPUT_CLASS}
        aria-label={t(
          'auto.components.right.sidebar.FileExplorerNameFilter.26fb73c6e3',
          'Find files'
        )}
        placeholder={
          scopeLabel
            ? t('fileExplorer.root.findInFolder', 'Find in {{path}}', { path: scopeLabel })
            : t('auto.components.right.sidebar.FileExplorerNameFilter.26fb73c6e3', 'Find files')
        }
        value={query}
        onChange={(event) => onQueryChange(event.currentTarget.value)}
        spellCheck={false}
      />
      {loading ? <Loader2 className="size-3 shrink-0 animate-spin text-muted-foreground" /> : null}
      {query ? (
        <Button
          type="button"
          variant="muted-field-icon"
          size="icon-xs"
          className="shrink-0"
          aria-label={t(
            'auto.components.right.sidebar.FileExplorerNameFilter.4d5a6b2a49',
            'Clear file filter'
          )}
          onClick={onClear}
        >
          <X className="size-3.5" />
        </Button>
      ) : null}
    </div>
  )
}
